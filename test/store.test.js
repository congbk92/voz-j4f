import { describe, it, expect, beforeEach } from 'vitest';
import { createStore, shouldClassify, MEMBER_PREFIX } from '../extension/lib/store.js';
import { normalize, RETRY_AFTER_MS } from '../extension/lib/config.js';
import { DEFAULT_LABELS, LEAN_QUESTIONS, labelSetHash } from '../extension/lib/labels.js';

const HASH = labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS);
const CFG = normalize({ apiKey: 'sk-test' });

function fakeStorage() {
  let data = {};
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

const post = (postId, memberId, text, extra = {}) => ({
  postId, memberId, name: `u${memberId}`, text, thread: 'T', joined: null, postCount: null, ...extra,
});

let now;
let store;
beforeEach(() => {
  now = 1_000_000_000_000;
  store = createStore(fakeStorage(), () => now);
});

describe('upsertPosts', () => {
  it('creates a member and stores the post', async () => {
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    const m = await store.getMember('42');
    expect(m.id).toBe('42');
    expect(m.totalPosts).toBe(1);
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0].postId).toBe('1');
  });

  it('dedupes by postId so re-reading a page does not inflate the count', async () => {
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    const m = await store.getMember('42');
    expect(m.totalPosts).toBe(1);
    expect(m.posts).toHaveLength(1);
  });

  it('keeps newest first and caps stored posts, leaving totalPosts monotonic', async () => {
    const cfg = { maxPostsPerMember: 20 };
    for (let i = 1; i <= 25; i++) {
      await store.upsertPosts([post(String(i), '42', `bình luận số ${i} đủ dài để lưu`)], cfg);
    }
    const m = await store.getMember('42');
    expect(m.posts).toHaveLength(20);
    expect(m.totalPosts).toBe(25);
    expect(m.posts[0].postId).toBe('25');   // newest first
    expect(m.posts.at(-1).postId).toBe('6'); // oldest five evicted
  });

  it('groups a mixed batch by member', async () => {
    await store.upsertPosts([
      post('1', '42', 'bình luận của bốn hai đủ dài'),
      post('2', '43', 'bình luận của bốn ba đủ dài'),
      post('3', '42', 'bình luận thứ hai của bốn hai'),
    ]);
    expect((await store.getMember('42')).totalPosts).toBe(2);
    expect((await store.getMember('43')).totalPosts).toBe(1);
  });

  it('records distinct thread titles, newest first, capped at 5', async () => {
    for (let i = 1; i <= 7; i++) {
      await store.upsertPosts([post(String(i), '42', `bình luận đủ dài số ${i}`, { thread: `T${i}` })]);
    }
    const m = await store.getMember('42');
    expect(m.threads).toHaveLength(5);
    expect(m.threads[0]).toBe('T7');
    expect(m.threads).not.toContain('T1');
  });

  it('does not duplicate an already-known thread title', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài thứ nhất', { thread: 'T' })]);
    await store.upsertPosts([post('2', '42', 'bình luận đủ dài thứ hai', { thread: 'T' })]);
    expect((await store.getMember('42')).threads).toEqual(['T']);
  });

  it('evicts the least recently seen member past maxMembers', async () => {
    const cfg = { maxMembers: 3 };
    for (const id of ['1', '2', '3']) {
      await store.upsertPosts([post('p' + id, id, `bình luận đủ dài số ${id}`)], cfg);
      now += 1000;
    }
    await store.upsertPosts([post('p4', '4', 'bình luận đủ dài số 4')], { maxMembers: 3 });
    expect(await store.getMember('1')).toBeNull();
    expect(await store.getMember('4')).not.toBeNull();
  });
});

describe('setLabel and setError', () => {
  it('stores a label and a null error', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài cho một thành viên')]);
    await store.setLabel('42', { choice: 'troll', probabilities: null, lean: {}, at: now, evidenceCount: 1, labelSetHash: HASH });
    const m = await store.getMember('42');
    expect(m.label.choice).toBe('troll');
    expect(m.lastError).toBeNull();
  });

  it('records an error without dropping the collected posts', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài cho một thành viên')]);
    await store.setError('42', { code: 401, message: 'unauthorized', at: now });
    const m = await store.getMember('42');
    expect(m.lastError.code).toBe(401);
    expect(m.posts).toHaveLength(1);
  });
});

describe('clear and listMembers', () => {
  it('removes every member key', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài một'), post('2', '43', 'bình luận đủ dài hai')]);
    await store.clear();
    expect(await store.listMembers()).toEqual([]);
    expect(await store.getMember('42')).toBeNull();
  });

  it('sorts members by cached post count descending', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài một')]);
    await store.upsertPosts([post('2', '43', 'bình luận đủ dài hai')]);
    await store.upsertPosts([post('3', '43', 'bình luận đủ dài ba')]);
    expect((await store.listMembers()).map((m) => m.id)).toEqual(['43', '42']);
  });
});

describe('shouldClassify', () => {
  const m = (over = {}) => ({
    id: '42', name: 'u42', totalPosts: 10,
    posts: Array.from({ length: 10 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
    threads: [], profile: {}, label: null, lastError: null, lastSeenAt: 0,
    ...over,
  });

  it('false when disabled', () => {
    expect(shouldClassify({ member: m(), cfg: normalize({ ...CFG, enabled: false }), now, hash: HASH })).toBe(false);
  });

  it('false without an API key', () => {
    expect(shouldClassify({ member: m(), cfg: normalize({ apiKey: '' }), now, hash: HASH })).toBe(false);
  });

  it('false with no stored posts', () => {
    expect(shouldClassify({ member: m({ posts: [], totalPosts: 0 }), cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('false below the threshold', () => {
    const member = m({ posts: m().posts.slice(0, 5), totalPosts: 5 });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true at the threshold with no label', () => {
    expect(shouldClassify({ member: m(), cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('false when the existing label is fresh', () => {
    const member = m({ label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: HASH } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true when the label set changed', () => {
    const member = m({ label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: 'deadbeef' } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('true when reclassifyEvery new posts have accrued past the cap', () => {
    const member = m({
      totalPosts: 25,
      label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: HASH },
    });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('false when fewer new posts than reclassifyEvery have accrued', () => {
    const member = m({
      totalPosts: 15,
      label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: HASH },
    });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true when labelTtlMs has elapsed', () => {
    const member = m({ label: { choice: 'troll', at: now - 604800000 - 1, evidenceCount: 10, labelSetHash: HASH } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('never expires when labelTtlMs is 0', () => {
    const member = m({ label: { choice: 'troll', at: 0, evidenceCount: 10, labelSetHash: HASH } });
    const cfg = normalize({ ...CFG, labelTtlMs: 0 });
    expect(shouldClassify({ member, cfg, now, hash: HASH })).toBe(false);
  });

  it('false while a recent error is still cooling down', () => {
    const member = m({ lastError: { code: 429, message: 'slow down', at: now - 1000 } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true once the error cooldown has elapsed', () => {
    const member = m({ lastError: { code: 429, message: 'slow down', at: now - RETRY_AFTER_MS - 1 } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('force bypasses threshold, freshness, and the error cooldown', () => {
    const member = m({
      posts: m().posts.slice(0, 1), totalPosts: 1,
      label: { choice: 'troll', at: now, evidenceCount: 1, labelSetHash: HASH },
      lastError: { code: 429, message: 'slow down', at: now },
    });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH, force: true })).toBe(true);
  });

  it('force still requires an API key and at least one post', () => {
    const noKey = normalize({ apiKey: '' });
    expect(shouldClassify({ member: m(), cfg: noKey, now, hash: HASH, force: true })).toBe(false);
    const noPosts = m({ posts: [], totalPosts: 0 });
    expect(shouldClassify({ member: noPosts, cfg: CFG, now, hash: HASH, force: true })).toBe(false);
  });
});
