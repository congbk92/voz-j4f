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

const memberRecord = (over = {}) => ({
  id: '42', name: 'u42', totalPosts: 12, posts: batch(12), seenIds: [], threads: [],
  profile: {}, label: null, lastError: null, lastSeenAt: 0, ...over,
});

async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

let storage;
let listener;
let sentToTabs;
let fetchCalls;

/**
 * The worker registers its message listener at module top level and reads
 * `chrome` there too, so every global it touches must exist before the import.
 */
async function boot({ cfg = {}, seed = [], respond } = {}) {
  const initial = { cfg: { apiKey: 'sk-test', modelId: 'typesafe-ai/jev', ...cfg } };
  for (const m of seed) initial[`m:${m.id}`] = m;

  storage = fakeStorage(initial);
  listener = null;
  sentToTabs = [];
  fetchCalls = [];

  globalThis.chrome = {
    storage: { local: storage },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      sendMessage: async (tabId, msg) => { sentToTabs.push({ tabId, msg }); return { ok: true }; },
    },
  };
  globalThis.fetch = vi.fn(async (url, init) => {
    fetchCalls.push({ url, init });
    return (respond || (() => okResponse()))(url, init);
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
    await boot();
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

  it('retries a 429 and stores the label once the gateway recovers', async () => {
    let calls = 0;
    await boot({
      respond: () => {
        calls += 1;
        return calls === 1 ? errResponse(429, 'slow down') : okResponse();
      },
    });
    await send({ type: 'collect', members: batch(12) });

    // The retry backs off a real 500ms, per §8. Nothing here asserts that timing;
    // it is only the wait the retry policy itself imposes.
    expect(await waitFor(async () => (await storedMember())?.label, 5000)).toBe(true);
    expect(fetchCalls).toHaveLength(2);
    expect((await storedMember()).lastError).toBeNull();
  });

  it('gives up after two retries and records the failure', async () => {
    await boot({ respond: () => errResponse(503, 'unavailable') });
    await send({ type: 'collect', members: batch(12) });

    expect(await waitFor(async () => (await storedMember())?.lastError, 5000)).toBe(true);
    expect(fetchCalls).toHaveLength(3);   // the attempt plus two retries
    expect((await storedMember()).lastError.code).toBe(503);
    expect((await storedMember()).label).toBeNull();
  });
});
