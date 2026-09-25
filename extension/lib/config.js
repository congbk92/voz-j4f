import { DEFAULT_LABELS } from './labels.js';

export const RETRY_AFTER_MS = 3600000;

export const DEFAULTS = {
  enabled: true,
  verbose: false,
  apiKey: '',
  modelId: 'typesafe-ai/jev',
  labels: DEFAULT_LABELS,
  threshold: 10,
  reclassifyEvery: 10,
  maxPostsPerMember: 20,
  maxMembers: 300,
  labelTtlMs: 604800000,
};

const CFG_KEY = 'cfg';

export function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  const cap = Math.max(1, Number(cfg.maxPostsPerMember) || DEFAULTS.maxPostsPerMember);
  cfg.maxPostsPerMember = cap;
  cfg.threshold = Math.min(cap, Math.max(1, Number(cfg.threshold) || 1));
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
