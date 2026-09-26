import { createConfig } from './lib/config.js';
import { createStore, shouldClassify } from './lib/store.js';
import { LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS, labelSetHash } from './lib/labels.js';
import {
  buildState, buildQuestions, callJev, parseAnswer, JevHttpError,
  isRetryableJevError, gatewayErrorMessage,
} from './lib/jev.js';
import { buildChipState } from './lib/chip.js';

// How long the queue holds off after the gateway asks us to wait, at most. Its
// `Retry-After` can name minutes; a service worker will not survive that, and
// nothing here is so urgent that it should try.
const RETRY_AFTER_PAUSE_MAX_MS = 30000;

/**
 * `HH:MM:SS.mmm`, local. Chrome's own console timestamps are a setting that is
 * off by default, and the point of these lines is knowing when a request went
 * out relative to everything else you are looking at.
 */
function stamp() {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const storage = chrome.storage.local;
const cfgStore = createConfig(storage);
const store = createStore(storage);

/**
 * The work queue, and the whole scheduling model.
 *
 * Every member that needs classifying or re-classifying goes in the queue.
 * A tick takes exactly ONE member, spaced at least `minRequestIntervalMs` apart,
 * and sends a single request for it. There is never more than one request in
 * flight. A member that fails goes back to the END of the queue, up to
 * `maxRequeues` times — so the retry policy is "wait your turn again", not a
 * backoff schedule, and a gateway having a bad minute no longer parks a member
 * for an hour while it clears.
 *
 * The member is re-checked when it reaches the front, not when it was queued:
 * the config or the stored posts may have changed while it waited, and a member
 * whose label has since become fresh must not spend a call.
 */
const queue = [];
const queued = new Set();          // every id in the queue, in flight included
const tries = new Map();           // memberId -> attempts already made this run
let running = false;               // one request at a time, by construction
let timer = null;
let lastStartAt = 0;
let pausedUntil = 0;               // set from the gateway's Retry-After

// Ids whose queued run must ignore threshold, freshness, and the error cooldown
// (spec §8). The flag has to survive into `runOne`, because running the
// predicate there without it would drop the very request that queued the member:
// a `force` from a collecting chip is below threshold, one from an error chip is
// inside RETRY_AFTER_MS, and one from a labeled chip is still fresh — all three
// are admitted by the handler's force check and rejected by a plain re-check.
const forced = new Set();

// memberId -> Set<tabId> that asked about it. We push results only to those
// tabs, which is why the extension needs no `tabs` permission (spec §5).
const watchers = new Map();

function watch(memberId, tabId) {
  if (tabId == null) return;
  if (!watchers.has(memberId)) watchers.set(memberId, new Set());
  watchers.get(memberId).add(tabId);
}

function chipFor(member, cfg) {
  return buildChipState(member, cfg, Date.now());
}

async function collectChips(ids) {
  const cfg = await cfgStore.get();
  const members = await store.getMembers(ids);
  const labels = {};
  for (const m of members) labels[m.id] = chipFor(m, cfg);
  return labels;
}

function enqueue(memberId, force = false) {
  // Already queued or in flight: that run is classifying this member right now,
  // so there is nothing left to force. Bailing here (rather than recording the
  // flag) also keeps `forced` from outliving its queue entry.
  if (queued.has(memberId)) return;
  if (force) forced.add(memberId);
  queued.add(memberId);
  queue.push(memberId);
  void schedule();
}

/**
 * Restart the ticker if it is not already running. The wait is measured from the
 * last request *start*, so the interval is the spacing between calls rather than
 * a delay added to each one — a slow request does not push the next one further
 * out than it has to.
 */
async function schedule() {
  if (timer !== null || running) return;
  // Reserved before the first await: a second caller arriving in the same tick
  // must not start a second timer.
  timer = -1;
  try {
    const { minRequestIntervalMs } = await cfgStore.get();
    const wait = Math.max(0, pausedUntil - Date.now(), lastStartAt + minRequestIntervalMs - Date.now());
    timer = setTimeout(() => { timer = null; void tick(); }, wait);
  } catch (e) {
    timer = null;
    console.error('[jev] could not schedule the queue', e);
  }
}

async function tick() {
  timer = null;
  if (running) return;

  // The gateway told us to wait. The pause is queue-wide rather than per-member:
  // a 429 is the gateway talking about itself, not about one member.
  if (Date.now() < pausedUntil) { void schedule(); return; }

  const id = queue.shift();
  if (id === undefined) return;   // idle; the next enqueue restarts the ticker

  running = true;
  lastStartAt = Date.now();
  // Consumed here so it cannot leak, and handed to the run so the re-check at
  // the front of the queue does not drop the very request that queued it.
  const force = forced.delete(id);
  let requeue = false;
  try {
    requeue = await runOne(id, force) === 'requeue';
  } catch (e) {
    console.error('[jev] classify failed', id, e);
  } finally {
    running = false;
  }

  if (requeue) {
    queue.push(id);            // back of the line; `queued` still holds it
    // A forced member stays forced across its requeues: the user asked for this
    // one by name, and a retry that dropped the flag would be re-checked against
    // the threshold it was forced past.
    if (force) forced.add(id);
  } else {
    queued.delete(id);
    tries.delete(id);
  }
  void schedule();
}

/** Returns 'requeue' when this member should wait its turn again, else 'done'. */
async function runOne(memberId, force = false) {
  const cfg = await cfgStore.get();
  const member = await store.getMember(memberId);
  if (!member) return 'done';

  // Re-checked here, at the front of the queue, and not only when it was queued:
  // the config may have changed and new posts may have arrived while this member
  // waited. `force` is the one thing that is not undone by the re-check, and the
  // predicate is the same one that put it in the queue.
  const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
  if (!shouldClassify({ member, cfg, now: Date.now(), hash, force })) {
    // Including the case where it stopped qualifying mid-queue — the toggle went
    // off, or the label became fresh. Drop the marker so the chip stops claiming
    // a retry that is not happening.
    if (member.retrying) await clearRetrying(memberId);
    return 'done';
  }

  const state = buildState(member);
  const questions = buildQuestions(cfg.labels, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);

  const attempt = (tries.get(memberId) || 0) + 1;
  const maxAttempts = cfg.maxRequeues + 1;   // the first try plus its requeues

  let answers;
  try {
    // One request, one attempt. Retrying is the queue's job now: a failure puts
    // this member back at the end of the line, which is both simpler to reason
    // about than a backoff schedule and gentler on a gateway that is struggling.
    //
    // Sent and settled are logged separately, with the time each happened: the
    // gap between consecutive "→" lines is the spacing that keeps the gateway
    // happy, and the gap to the matching "←" is how long it took to answer.
    console.log(`[jev] ${stamp()} → request`, memberId,
      `try ${attempt}/${maxAttempts}`, `queued ${queue.length}`);
    const sentAt = Date.now();
    answers = await callJev({
      apiKey: cfg.apiKey,
      modelId: cfg.modelId,
      state,
      questions,
      policy: { maxAttempts: 1, requestTimeoutMs: cfg.requestTimeoutMs },
    });
    console.log(`[jev] ${stamp()} ← ok`, memberId, `${Date.now() - sentAt}ms`);
  } catch (e) {
    const code = e instanceof JevHttpError ? e.status : 0;
    const why = gatewayErrorMessage(e) || e.message;

    // The gateway is talking about itself, not about this member, so the pause
    // applies to the whole queue.
    const hint = e instanceof JevHttpError ? e.retryAfterMs : null;
    if (typeof hint === 'number' && hint > 0) {
      pausedUntil = Date.now() + Math.min(hint, RETRY_AFTER_PAUSE_MAX_MS);
    }

    // A client error will not heal by waiting, so it is not requeued: spending
    // four calls to be told the key is rejected four times helps nobody.
    if (isRetryableJevError(e) && attempt < maxAttempts) {
      tries.set(memberId, attempt);
      // The *next* try, which is what the chip is waiting on.
      await store.setRetrying(memberId, { attempt: attempt + 1, maxAttempts, at: Date.now() });
      await broadcast(memberId);
      console.warn(`[jev] ${stamp()} ✗ requeueing`, memberId,
        `${attempt}/${maxAttempts}`, code, why);
      return 'requeue';
    }

    // Logged because a final gateway failure used to be silent: setError returns
    // normally, so nothing upstream of it ever sees the failure. Visible in the
    // service worker's console (chrome://extensions), not the page's F12.
    console.warn(`[jev] ${stamp()} ✗ gave up`, memberId, code, why);
    await clearRetrying(memberId);
    // `retryable` is what decides whether the cooldown in `shouldClassify`
    // applies: a rejected key parks the member, a busy gateway must not.
    await store.setError(memberId, { code, message: e.message, at: Date.now(), retryable: isRetryableJevError(e) });
    await broadcast(memberId);
    return 'done';
  }
  await clearRetrying(memberId);

  let parsed;
  try {
    parsed = parseAnswer(answers, cfg.labels);   // throws on an invented choice
  } catch (e) {
    await store.setError(memberId, { code: -1, message: e.message, at: Date.now() });
    await broadcast(memberId);
    return 'done';
  }

  await store.setLabel(memberId, {
    choice: parsed.choice,
    probabilities: parsed.probabilities,
    lean: parsed.lean,
    at: Date.now(),
    evidenceCount: member.totalPosts,
    labelSetHash: hash,
  });
  await broadcast(memberId);
  return 'done';
}

/** Drop the retry marker, but only if the record actually carries one. */
async function clearRetrying(memberId) {
  const member = await store.getMember(memberId);
  if (member && member.retrying) await store.setRetrying(memberId, null);
}

async function broadcast(memberId) {
  const tabs = watchers.get(memberId);
  if (!tabs || tabs.size === 0) return;
  const cfg = await cfgStore.get();
  const member = await store.getMember(memberId);
  if (!member) return;
  const chip = chipFor(member, cfg);
  for (const tabId of tabs) {
    chrome.tabs.sendMessage(tabId, { type: 'labels', labels: { [memberId]: chip } })
      .catch(() => {});   // the tab may have navigated away or closed
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'collect') {
        const cfg = await cfgStore.get();
        const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
        const members = await store.upsertPosts(msg.members, cfg);
        const reply = await collectChips(members.map((m) => m.id));
        for (const m of members) {
          watch(m.id, sender.tab && sender.tab.id);
          if (shouldClassify({ member: m, cfg, now: Date.now(), hash })) enqueue(m.id);
        }
        sendResponse({ labels: reply });
        return;
      }

      if (msg.type === 'force') {
        const cfg = await cfgStore.get();
        const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
        const member = await store.getMember(msg.memberId);
        if (!member) { sendResponse({ ok: false, error: 'unknown member' }); return; }
        if (!shouldClassify({ member, cfg, now: Date.now(), hash, force: true })) {
          // Named from the condition that actually failed. A force is refused by
          // exactly three things — no key, no stored posts, and the master switch
          // — so a ternary over `apiKey` would tell a user with a good key and the
          // toggle off that their API key is missing (spec §8's trigger gained the
          // `enabled` gate; §7 promises the switch stops spending).
          let error = 'no posts collected';
          if (!cfg.apiKey) error = 'missing API key';
          else if (!cfg.enabled) error = 'disabled';
          sendResponse({ ok: false, error });
          return;
        }
        watch(msg.memberId, sender.tab && sender.tab.id);
        enqueue(msg.memberId, true);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'clear') {
        await store.clear();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'rerender') {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `unknown message: ${msg.type}` });
    } catch (e) {
      console.error('[jev] message handler failed', msg, e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;   // keep the channel open for the async reply
});
