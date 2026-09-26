import { DEFAULT_LABELS } from './labels.js';
import { DEFAULT_RETRY_POLICY } from './jev.js';

/**
 * How long a member whose classification *failed for good* is left alone. Only
 * failures that cannot heal are held this long — a rejected key, say. A busy
 * gateway is eligible again on the next page load, because an hour of silence
 * looks exactly like a broken extension.
 */
export const RETRY_AFTER_MS = 3600000;

export const DEFAULTS = {
  enabled: true,
  verbose: false,   // show confidence, cache counts and expiry under each chip
  apiKey: '',
  modelId: 'typesafe-ai/jev',
  labels: DEFAULT_LABELS,
  threshold: 5,
  reclassifyEvery: 5,
  maxPostsPerMember: 20,
  maxMembers: 300,
  labelTtlMs: 604800000,

  // The queue knobs. One member leaves the queue per `minRequestIntervalMs`, and
  // that spacing is what prevents the rate limit rather than surviving it.
  // `maxRequeues` is the whole retry policy: a failed member goes back to the end
  // of the queue this many times before it is recorded as failed.
  minRequestIntervalMs: 5000,
  maxRequeues: 3,
  requestTimeoutMs: DEFAULT_RETRY_POLICY.requestTimeoutMs,
};

const CFG_KEY = 'cfg';

/**
 * Labels stored before icons existed carry no `icon` key, and a stored `labels`
 * array replaces `DEFAULTS.labels` wholesale — so those installs would render
 * every chip with no icon and never notice, because the defaults they should
 * have come from are shadowed by their own saved copy. Backfill by `key`.
 *
 * Only a *missing* icon is filled. An explicit empty string is left alone: that
 * is a user who cleared the field, not a record from before the field existed.
 */
function backfillIcons(labels) {
  if (!Array.isArray(labels)) return DEFAULTS.labels;
  const byKey = new Map(DEFAULT_LABELS.map((l) => [l.key, l.icon]));
  return labels.map((l) => (
    l && l.icon === undefined && byKey.has(l.key) ? { ...l, icon: byKey.get(l.key) } : l
  ));
}

export function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  cfg.labels = backfillIcons(cfg.labels);
  const n = Number(cfg.maxPostsPerMember);
  const cap = Math.max(1, Number.isFinite(n) ? n : DEFAULTS.maxPostsPerMember);
  cfg.maxPostsPerMember = cap;

  // Every count below floors at 1. A zero is not a smaller setting, it is a broken
  // one — both are reachable by typing 0 into the options page:
  //   maxMembers 0      -> eviction computes excess = all.length and drops EVERY
  //                        stored member, including the batch just written.
  //   reclassifyEvery 0 -> `totalPosts - evidenceCount < 0` is never true, so no
  //                        label is ever fresh and every collect re-classifies
  //                        every member above the threshold: unbounded gateway spend.
  // Clamped here because `normalize` is the single funnel every config read and
  // write passes through, so it binds every writer, not just the options page.
  const nMembers = Number(cfg.maxMembers);
  cfg.maxMembers = Math.max(1, Number.isFinite(nMembers) ? nMembers : DEFAULTS.maxMembers);
  const nReclassify = Number(cfg.reclassifyEvery);
  cfg.reclassifyEvery = Math.max(1, Number.isFinite(nReclassify) ? nReclassify : DEFAULTS.reclassifyEvery);

  cfg.threshold = Math.min(cap, Math.max(1, Number(cfg.threshold) || 1));

  // Zero is meaningful for the interval — it disables the spacing, which the test
  // suite relies on to stay fast — so this floors at 0 rather than 1.
  const nInterval = Number(cfg.minRequestIntervalMs);
  cfg.minRequestIntervalMs = Math.max(0, Number.isFinite(nInterval) ? nInterval : DEFAULTS.minRequestIntervalMs);

  // Requeues floor at 1 because 0 would mean a member is never retried at all:
  // one transient blip and it sits on an error chip until the page is revisited.
  const nRequeues = Number(cfg.maxRequeues);
  cfg.maxRequeues = Math.min(10, Math.max(1, Number.isFinite(nRequeues) ? Math.trunc(nRequeues) : DEFAULTS.maxRequeues));

  const nTimeout = Number(cfg.requestTimeoutMs);
  cfg.requestTimeoutMs = Math.max(1000, Number.isFinite(nTimeout) ? nTimeout : DEFAULTS.requestTimeoutMs);
  return cfg;
}

export function createConfig(storage) {
  return {
    async get() {
      const got = await storage.get(CFG_KEY);
      return normalize(got[CFG_KEY]);
    },
    async set(patch) {
      const current = await this.get();
      const next = normalize({ ...current, ...patch });
      await storage.set({ [CFG_KEY]: next });
      return next;
    },
  };
}
