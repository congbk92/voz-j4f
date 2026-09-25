import { createConfig } from './lib/config.js';
import { createStore, shouldClassify } from './lib/store.js';
import { LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS, labelSetHash } from './lib/labels.js';
import { buildState, buildQuestions, callJev, parseAnswer, JevHttpError } from './lib/jev.js';
import { buildChipState } from './lib/chip.js';

const CONCURRENCY = 2;

const storage = chrome.storage.local;
const cfgStore = createConfig(storage);
const store = createStore(storage);

const queue = [];
const inFlight = new Set();

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
  // Already in flight: that run is classifying this member right now, so there
  // is nothing left to force. Bailing here (rather than recording the flag) also
  // keeps `forced` from outliving its queue entry.
  if (inFlight.has(memberId)) return;
  if (force) forced.add(memberId);
  if (queue.includes(memberId)) return;   // upgraded in place by the flag above
  queue.push(memberId);
  pump();
}

function pump() {
  while (inFlight.size < CONCURRENCY && queue.length) {
    const id = queue.shift();
    const force = forced.delete(id);   // consumed here, so it cannot leak
    inFlight.add(id);
    runOne(id, force).catch((e) => console.error('[jev] classify failed', id, e))
      .finally(() => { inFlight.delete(id); pump(); });
  }
}

async function runOne(memberId, force = false) {
  const cfg = await cfgStore.get();
  const member = await store.getMember(memberId);
  if (!member) return;

  // Re-checked with the same predicate that queued it: a duplicate enqueue is
  // dropped, but a forced one is not undone by the re-check.
  const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
  if (!shouldClassify({ member, cfg, now: Date.now(), hash, force })) return;

  const state = buildState(member);
  const questions = buildQuestions(cfg.labels, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);

  let answers;
  try {
    answers = await callJev({ apiKey: cfg.apiKey, modelId: cfg.modelId, state, questions });
  } catch (e) {
    const code = e instanceof JevHttpError ? e.status : 0;
    await store.setError(memberId, { code, message: e.message, at: Date.now() });
    await broadcast(memberId);
    return;
  }

  let parsed;
  try {
    parsed = parseAnswer(answers, cfg.labels);   // throws on an invented choice
  } catch (e) {
    await store.setError(memberId, { code: -1, message: e.message, at: Date.now() });
    await broadcast(memberId);
    return;
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
