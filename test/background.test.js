import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GATEWAY_ENDPOINT } from '../extension/lib/jev.js';

const ANSWER = {
  answers: { archetype: { type: 'choice', choice: 'troll', probabilities: { troll: 0.7 } } },
};

const okResponse = (body = ANSWER) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});
const errResponse = (status, body = 'nope') => ({
  ok: false, status, json: async () => ({}), text: async () => body,
});

/** In-memory chrome.storage.local, matching the subset the app reads and writes. */
function fakeStorage(initial) {
  let data = { ...initial };
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { data = { ...data, ...obj }; },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}

/** One scraped post, in the shape content.js sends. */
const post = (postId, memberId = '42') => ({
  postId: String(postId), memberId, name: `u${memberId}`,
  text: `bình luận đủ dài số ${postId}`, thread: 'T', joined: null, postCount: null,
});
const batch = (n) => Array.from({ length: n }, (_, i) => post(i + 1));
/** Several distinct members in one collect, for the tests that need a queue. */
const batchFor = (memberIds, per) => memberIds.flatMap(
  (id) => Array.from({ length: per }, (_, i) => post(`${id}-${i + 1}`, id)),
);

const memberRecord = (over = {}) => ({
  id: '42', name: 'u42', totalPosts: 12, posts: batch(12), seenIds: [], threads: [],
  profile: {}, label: null, lastError: null, lastSeenAt: 0, ...over,
});

/**
 * Monotonic deadline, deliberately not `Date.now()`: this sandbox's wall clock
 * steps forward under load, which makes a wall-clock deadline expire early and
 * turns a wait into a spurious failure.
 */
async function waitFor(fn, ms = 2000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

let storage;
let previousStorage = null;
let listener;
let sentToTabs;
let fetchCalls;
// Reassignable so a test can make the gateway recover partway through, which is
// the whole point of the requeue tests.
let fetchResponder;

/**
 * The worker registers its message listener at module top level and reads
 * `chrome` there too, so every global it touches must exist before the import.
 */
async function boot({ cfg = {}, seed = [], respond } = {}) {
  // Pacing off by default: the production interval is seconds long, and every
  // test that is not about pacing would otherwise pay it between calls. The
  // pacing test asks for it back explicitly.
  const initial = { cfg: { apiKey: 'sk-test', modelId: 'typesafe-ai/jev', minRequestIntervalMs: 0, ...cfg } };
  for (const m of seed) initial[`m:${m.id}`] = m;

  // Neutralise the worker from the previous test before it can spend anything on
  // this one. Its ticker outlives `vi.resetModules()`, and `callJev` resolves
  // `fetch` from the global when it is called, so a queue left unfinished would
  // call straight into the stub installed below. Switching its stored toggle off
  // makes it drain without calling — the same gate the product uses, rather than
  // a test-only backdoor.
  if (previousStorage) await previousStorage.set({ cfg: { enabled: false } });

  storage = fakeStorage(initial);
  previousStorage = storage;
  listener = null;
  sentToTabs = [];
  // Per-boot arrays, captured by the stub below rather than read off the module
  // binding: a worker left over from an earlier test would otherwise push its
  // stale calls into this test's count.
  fetchCalls = [];
  const calls = fetchCalls;

  globalThis.chrome = {
    storage: { local: storage },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      sendMessage: async (tabId, msg) => { sentToTabs.push({ tabId, msg }); return { ok: true }; },
    },
  };
  fetchResponder = respond || (() => okResponse());
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return fetchResponder(url, init);
  });

  vi.resetModules();
  await import('../extension/background.js');
}

const send = (msg, sender = { tab: { id: 7 } }) =>
  new Promise((resolve) => { listener(msg, sender, resolve); });

const storedMember = async (id = '42') => (await storage.get(`m:${id}`))[`m:${id}`] || null;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('background worker', () => {
  it('does not call the gateway when a force arrives with the toggle off', async () => {
    // The regression guard: `force` used to short-circuit before the `enabled`
    // check, so this exact sequence spent the user's credits.
    await boot({ cfg: { enabled: false }, seed: [memberRecord()] });

    const reply = await send({ type: 'force', memberId: '42' });
    expect(reply.ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('classifies a forced member that is below the threshold', async () => {
    // The flag has to survive all the way to the re-check at the front of the
    // queue. A force from a collecting chip is below threshold by definition, so
    // a plain re-check would drop the very request that queued the member.
    await boot({ cfg: { threshold: 10 } });
    await send({ type: 'collect', members: batch(3) });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchCalls).toHaveLength(0);   // below the threshold: not classified

    const reply = await send({ type: 'force', memberId: '42' });
    expect(reply.ok).toBe(true);
    expect(await waitFor(async () => (await storedMember())?.label, 10000)).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect((await storedMember()).label.choice).toBe('troll');
  }, 20000);

  it('names the toggle, not a missing key, when it refuses a force', async () => {
    // A user with a valid key and the toggle off was told their key was missing.
    await boot({ cfg: { enabled: false }, seed: [memberRecord()] });
    const reply = await send({ type: 'force', memberId: '42' });
    expect(reply.error).not.toBe('missing API key');
    expect(reply.error).toBe('disabled');
  });

  it('enqueues a collect above the threshold, calls the gateway, and stores the label', async () => {
    await boot();
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(async () => (await storedMember())?.label)).toBe(true);
    expect((await storedMember()).label.choice).toBe('troll');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(GATEWAY_ENDPOINT);
    expect(fetchCalls[0].init.headers.Authorization).toBe('Bearer sk-test');
    // And the tab that collected is told, which is the whole reason the worker
    // tracks watchers instead of holding the `tabs` permission.
    expect(sentToTabs.at(-1).tabId).toBe(7);
    expect(sentToTabs.at(-1).msg.labels['42'].state).toBe('labeled');
  });

  it('does not classify a collect that stays below the threshold', async () => {
    // The default threshold is 5, so "below" has to be stated rather than assumed.
    await boot({ cfg: { threshold: 10 } });
    await send({ type: 'collect', members: batch(3) });
    // Nothing to wait for: give the queue a turn, then assert it stayed empty.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toHaveLength(0);
    expect((await storedMember()).label).toBeNull();
  });

  it('sets lastError and caches no label on a 401, and does not retry it', async () => {
    await boot({ respond: () => errResponse(401, 'unauthorized') });
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(async () => (await storedMember())?.lastError)).toBe(true);
    const m = await storedMember();
    expect(m.lastError.code).toBe(401);
    expect(m.label).toBeNull();
    // A client error is final: retrying it would multiply failed calls and delay
    // the `lastError` the chip and popup read.
    expect(fetchCalls).toHaveLength(1);
  });

  it('requeues a 429 and stores the label once the gateway recovers', async () => {
    let attempt = 0;
    await boot({
      respond: () => {
        attempt += 1;
        return attempt === 1 ? errResponse(429, 'slow down') : okResponse();
      },
    });
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(async () => (await storedMember())?.label, 10000)).toBe(true);
    expect(fetchCalls).toHaveLength(2);
    expect((await storedMember()).lastError).toBeNull();
  });

  it('gives up after maxRequeues and records the failure', async () => {
    await boot({ cfg: { maxRequeues: 3 }, respond: () => errResponse(503, 'unavailable') });
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(async () => (await storedMember())?.lastError, 15000)).toBe(true);
    expect(fetchCalls).toHaveLength(4);   // the first try plus three requeues
    expect((await storedMember()).lastError.code).toBe(503);
    expect((await storedMember()).label).toBeNull();
  }, 30000);

  it('logs every request with the time it went out', async () => {
    // The worker's console is the only place a gateway problem is visible, so
    // the send lines are load-bearing rather than decoration.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await boot();
      await send({ type: 'collect', members: batch(12) });
      expect(await waitFor(async () => (await storedMember())?.label)).toBe(true);

      const lines = log.mock.calls.map((args) => args.join(' '));
      const sent = lines.find((l) => l.includes('→ request'));
      expect(sent).toBeTruthy();
      expect(sent).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);   // HH:MM:SS.mmm
      expect(sent).toContain('42');                        // which member
      expect(sent).toContain('try 1/');                    // which attempt
      expect(lines.some((l) => l.includes('← ok'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 20000);

  it('never has two requests in flight at once', async () => {
    // Not the same claim as the spacing test: an interval bounds how often a
    // request *starts*, and two slow requests would still overlap under it. This
    // holds the first response open and checks that nothing else goes out while
    // it is pending.
    let release;
    const held = new Promise((r) => { release = r; });
    let first = true;
    await boot({
      // Pacing off deliberately: the interval must not be what is being measured.
      cfg: { minRequestIntervalMs: 0 },
      respond: async () => {
        if (first) { first = false; await held; }
        return okResponse();
      },
    });
    await send({ type: 'collect', members: batchFor(['1', '2', '3'], 12) });
    expect(await waitFor(() => fetchCalls.length >= 1)).toBe(true);

    // While the first request is stuck open, the page mutates and collects
    // again — which is what the content script does constantly on a live thread.
    // That is the moment a second request could overlap the first.
    await send({ type: 'collect', members: batchFor(['1', '2', '3'], 12) });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchCalls).toHaveLength(1);

    release();
    expect(await waitFor(() => fetchCalls.length === 3, 10000)).toBe(true);
  }, 20000);

  it('honours a configured requeue budget', async () => {
    await boot({ cfg: { maxRequeues: 1 }, respond: () => errResponse(503, 'unavailable') });
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(async () => (await storedMember())?.lastError, 10000)).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  }, 20000);

  it('marks a busy gateway as retryable, so the member is not parked for an hour', async () => {
    // The reported bug: one 429 used to cost a full RETRY_AFTER_MS, so a member
    // that failed while the provider was busy was never classified again until
    // the next hour — indistinguishable, on the page, from the extension being
    // broken. A retryable error has to stay eligible.
    await boot({ cfg: { maxRequeues: 1 }, respond: () => errResponse(429, 'slow down') });
    await send({ type: 'collect', members: batch(12) });
    expect(await waitFor(async () => (await storedMember())?.lastError, 10000)).toBe(true);
    expect((await storedMember()).lastError.retryable).toBe(true);

    // The gateway recovers, and the next collect picks the member straight back
    // up rather than waiting out the cooldown.
    fetchResponder = () => okResponse();
    await send({ type: 'collect', members: batch(12) });
    expect(await waitFor(async () => (await storedMember())?.label, 10000)).toBe(true);
  }, 30000);

  it('parks a rejected key instead, since waiting will not fix it', async () => {
    await boot({ respond: () => errResponse(401, 'unauthorized') });
    await send({ type: 'collect', members: batch(12) });
    expect(await waitFor(async () => (await storedMember())?.lastError, 10000)).toBe(true);
    const m = await storedMember();
    expect(m.lastError.retryable).toBe(false);

    // A second collect must not spend another call to be told the same thing.
    const before = fetchCalls.length;
    await send({ type: 'collect', members: batch(12) });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchCalls).toHaveLength(before);
  }, 20000);

  it('re-checks the member when its turn comes, not when it was queued', async () => {
    // The config can change while a member waits in the queue. Raising the
    // threshold past what the member has collected must drop it without spending
    // the call — this is the number-of-cached-comments re-check.
    await boot({ cfg: { minRequestIntervalMs: 300 } });
    await send({ type: 'collect', members: batchFor(['1', '2'], 12) });
    expect(await waitFor(() => fetchCalls.length === 1, 5000)).toBe(true);

    await storage.set({
      cfg: { apiKey: 'sk-test', modelId: 'typesafe-ai/jev', minRequestIntervalMs: 300, threshold: 99 },
    });
    await new Promise((r) => setTimeout(r, 1000));
    // The second member reached the front, stopped qualifying, and was skipped.
    expect(fetchCalls).toHaveLength(1);
  }, 20000);

  it('holds the whole queue when the gateway asks us to wait', async () => {
    // A 429 is the gateway talking about itself, so the pause is queue-wide:
    // burning the other members' turns against a gateway that just said stop
    // only earns more 429s.
    await boot({
      cfg: { maxRequeues: 1 },
      respond: () => ({
        ok: false, status: 429, text: async () => 'busy', json: async () => ({}),
        headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '1' : null) },
      }),
    });
    await send({ type: 'collect', members: batchFor(['1', '2', '3'], 12) });
    await waitFor(() => fetchCalls.length >= 1, 5000);
    await new Promise((r) => setTimeout(r, 400));
    // The Retry-After second has not elapsed, so the other two are still waiting.
    expect(fetchCalls.length).toBeLessThan(3);
  }, 20000);

  it('starts at most one request per interval, however many members arrive', async () => {
    // The burst this prevents is what earns the 429: a page turns up every
    // member at once, and refilling a freed slot immediately spent all of them
    // against the gateway in the same moment.
    await boot({ cfg: { minRequestIntervalMs: 400 } });
    await send({ type: 'collect', members: batchFor(['1', '2', '3'], 12) });

    await new Promise((r) => setTimeout(r, 250));
    expect(fetchCalls).toHaveLength(1);
    // Nothing is dropped for being over the interval — the queue just drains.
    expect(await waitFor(() => fetchCalls.length === 3, 10000)).toBe(true);
  }, 20000);

  it('stops retrying when the toggle is switched off mid-backoff', async () => {
    // The parked R17: the old loop never re-read the config, so a disable during
    // a backoff still let the remaining attempts fire — paid calls, after the
    // user had already hit stop.
    await boot({
      respond: async () => {
        await storage.set({
          cfg: { apiKey: 'sk-test', modelId: 'typesafe-ai/jev', minRequestIntervalMs: 0, enabled: false },
        });
        return errResponse(429, 'slow down');
      },
    });
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(() => fetchCalls.length >= 1)).toBe(true);
    // Long enough that the first retry would have fired had it not been refused.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fetchCalls).toHaveLength(1);
    // And no error was recorded either: a fresh `lastError` here would defer the
    // member a full RETRY_AFTER_MS once the toggle came back on.
    expect((await storedMember()).lastError).toBeNull();
  }, 20000);
});
