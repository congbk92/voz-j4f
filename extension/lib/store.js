import { normalize, RETRY_AFTER_MS } from './config.js';

export const MEMBER_PREFIX = 'm:';
const MAX_THREADS = 5;

const key = (id) => `${MEMBER_PREFIX}${id}`;
const emptyMember = (id, name) => ({
  id, name, totalPosts: 0, posts: [], seenIds: [], threads: [], profile: {},
  label: null, lastError: null, lastSeenAt: 0,
});

/** Pure. Decides whether this member is due for a (re-)classification. */
export function shouldClassify({ member, cfg, now, hash, force = false }) {
  if (!member || !cfg.apiKey) return false;
  if (!member.posts || member.posts.length === 0) return false;
  if (force) return true;

  if (!cfg.enabled) return false;
  if (member.posts.length < cfg.threshold) return false;

  const l = member.label;
  if (l) {
    const freshByHash = l.labelSetHash === hash;
    const freshByTtl = !(cfg.labelTtlMs > 0 && now - l.at >= cfg.labelTtlMs);
    const freshByEvidence = (member.totalPosts - l.evidenceCount) < cfg.reclassifyEvery;
    if (freshByHash && freshByTtl && freshByEvidence) return false;
  }

  if (member.lastError && now - member.lastError.at < RETRY_AFTER_MS) return false;
  return true;
}

export function createStore(storage, now = () => Date.now()) {
  const store = {
    async getMember(id) {
      const got = await storage.get(key(id));
      return got[key(id)] || null;
    },

    async getMembers(ids) {
      const keys = ids.map(key);
      const got = await storage.get(keys);
      return ids.map((id) => got[key(id)]).filter(Boolean);
    },

    async listMembers() {
      const all = await storage.get(null);
      return Object.entries(all)
        .filter(([k]) => k.startsWith(MEMBER_PREFIX))
        .map(([, v]) => v)
        .sort((a, b) => b.posts.length - a.posts.length);
    },

    async count() {
      const all = await storage.get(null);
      return Object.keys(all).filter((k) => k.startsWith(MEMBER_PREFIX)).length;
    },

    /** Group by member, dedupe by postId, cap stored posts, evict old members. */
    async upsertPosts(posts, rawCfg) {
      const cfg = normalize(rawCfg);
      const t = now();
      const ids = [...new Set(posts.map((p) => p.memberId))];

      const existing = {};
      for (const m of await store.getMembers(ids)) existing[m.id] = m;
      const created = [];

      const write = {};
      for (const id of ids) {
        const batch = posts.filter((p) => p.memberId === id);
        const prev = existing[id];
        if (!prev) created.push(id);
        const m = prev
          ? {
              ...prev,
              posts: [...prev.posts],
              seenIds: [...(prev.seenIds || [])],
              threads: [...prev.threads],
              profile: { ...prev.profile },
            }
          : emptyMember(id, batch[batch.length - 1].name);

        // `known` spans the stored window AND the ring of recently seen ids, so a
        // post the cap has evicted is not treated as new when its page is re-sent.
        // Without the ring, dedupe only holds below the cap and §4's idempotence
        // claim is false for the members seen most.
        const known = new Set(m.seenIds);
        for (const p of m.posts) known.add(p.postId);

        const addedIds = [];
        // `batch` arrives in document order — oldest first — so unshifting each
        // post in turn leaves `posts` newest-first. Callers must preserve that.
        for (const p of batch) {
          if (known.has(p.postId)) continue;
          known.add(p.postId);
          addedIds.push(p.postId);
          m.posts.unshift({ postId: p.postId, text: p.text, ts: t });
          m.totalPosts += 1;
        }

        if (addedIds.length) {
          m.posts = m.posts.slice(0, cfg.maxPostsPerMember);
          m.seenIds = [...new Set([...addedIds, ...m.seenIds])]
            .slice(0, cfg.maxPostsPerMember * 3);
          // Reversed: the batch is oldest-first, so its last thread is the newest.
          const batchThreads = [...new Set(batch.map((p) => p.thread).filter(Boolean))].reverse();
          m.threads = [...new Set([...batchThreads, ...m.threads])].slice(0, MAX_THREADS);
        }

        const latest = batch[batch.length - 1];
        if (latest.name) m.name = latest.name;
        if (latest.joined) m.profile.joined = latest.joined;
        if (latest.postCount != null) m.profile.postCount = latest.postCount;
        m.lastSeenAt = t;

        write[key(id)] = m;
      }

      await storage.set(write);

      // Evict only when this call created members, so the scan stays rare.
      if (created.length) {
        const all = (await store.listMembers()).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
        const excess = all.length - cfg.maxMembers;
        if (excess > 0) {
          await storage.remove(all.slice(0, excess).map((m) => key(m.id)));
        }
      }

      return Object.values(write);
    },

    async setLabel(id, label) {
      const m = await store.getMember(id);
      if (!m) return null;
      const next = { ...m, label, lastError: null };
      await storage.set({ [key(id)]: next });
      return next;
    },

    async setError(id, error) {
      const m = await store.getMember(id);
      if (!m) return null;
      const next = { ...m, lastError: error };
      await storage.set({ [key(id)]: next });
      return next;
    },

    async clear() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(MEMBER_PREFIX));
      if (keys.length) await storage.remove(keys);
    },
  };

  return store;
}
