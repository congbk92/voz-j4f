import { describe, it, expect, vi } from 'vitest';
import {
  buildState, buildQuestions, callJev, parseAnswer,
  GATEWAY_ENDPOINT, MAX_POSTS, MAX_POST_CHARS,
  JevHttpError, JevAnswerError,
} from '../extension/lib/jev.js';
import { DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS } from '../extension/lib/labels.js';

const member = (posts, extra = {}) => ({
  id: '1', name: 'alice', totalPosts: posts.length,
  posts: posts.map((t, i) => ({ postId: String(i), text: t, ts: 0 })),
  threads: ['Thread A'], profile: { joined: '2019', postCount: '4213' },
  ...extra,
});

describe('buildState', () => {
  it('takes the 6 longest posts, ranked before truncation', () => {
    const posts = ['a'.repeat(10), 'b'.repeat(900), 'c'.repeat(3000), 'd'.repeat(50),
                   'e'.repeat(1200), 'f'.repeat(800), 'g'.repeat(700)];
    const state = buildState(member(posts));
    expect(state.posts).toHaveLength(MAX_POSTS);
    // c (3000), e (1200), b (900), f (800), g (700), d (50) — by original length.
    // Ranking uses ORIGINAL length, so the four posts above the 800-char cap keep
    // their original order even though all four truncate to the same length.
    expect(state.posts.map((p) => p[0])).toEqual(['c', 'e', 'b', 'f', 'g', 'd']);
    expect(state.posts[0]).toHaveLength(MAX_POST_CHARS);
    expect(state.posts[1]).toHaveLength(MAX_POST_CHARS);
    expect(state.posts[4]).toHaveLength(700);
    expect(state.posts[5]).toHaveLength(50);
    expect(state.posts).not.toContain('a'.repeat(10));
  });

  it('truncates each post at 800 characters', () => {
    const state = buildState(member(['x'.repeat(5000)]));
    expect(state.posts[0]).toHaveLength(MAX_POST_CHARS);
  });

  it('includes member context when observed', () => {
    const state = buildState(member(['nội dung đủ dài để dùng được ở đây']));
    expect(state.member).toBe('alice');
    expect(state.joined).toBe('2019');
    expect(state.postCount).toBe('4213');
    expect(state.threads).toEqual(['Thread A']);
  });

  it('omits context keys that were never observed', () => {
    const m = member(['nội dung đủ dài để dùng được ở đây'], {
      profile: {}, threads: [],
    });
    const state = buildState(m);
    expect('joined' in state).toBe(false);
    expect('postCount' in state).toBe(false);
    expect('threads' in state).toBe(false);
  });

  it('caps threads at 5', () => {
    const m = member(['nội dung đủ dài để dùng được ở đây'], {
      threads: ['1', '2', '3', '4', '5', '6', '7'],
    });
    expect(buildState(m).threads).toHaveLength(5);
  });
});

describe('buildQuestions', () => {
  it('mirrors the label set into choice criteria', () => {
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    expect(q.archetype.type).toBe('choice');
    expect(q.archetype.instructions).toBe(ARCHETYPE_INSTRUCTIONS);
    expect(Object.keys(q.archetype.criteria)).toHaveLength(16);
    expect(q.archetype.criteria.troll).toContain('gây tranh cãi');
  });

  it('builds one boolean per lean question', () => {
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    expect(Object.keys(q.lean)).toHaveLength(6);
    for (const v of Object.values(q.lean)) expect(v.type).toBe('boolean');
  });
});

describe('callJev', () => {
  const ok = (body) => vi.fn(async () => ({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  }));

  it('posts to the gateway with the spec headers and body', async () => {
    const fetchImpl = ok({ answers: { archetype: { type: 'choice', choice: 'troll' } } });
    await callJev({
      apiKey: 'sk-abc', modelId: 'typesafe-ai/jev',
      state: { member: 'alice' }, questions: { archetype: {} }, fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GATEWAY_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-abc');
    expect(init.headers['ai-evaluation-model-specification-version']).toBe('4');
    expect(init.headers['ai-model-id']).toBe('typesafe-ai/jev');
    expect(JSON.parse(init.body)).toEqual({
      state: { member: 'alice' }, questions: { archetype: {} },
    });
  });

  it('returns the answers map', async () => {
    const fetchImpl = ok({ answers: { archetype: { type: 'choice', choice: 'troll' } } });
    const answers = await callJev({ apiKey: 'k', modelId: 'm', state: {}, questions: {}, fetchImpl });
    expect(answers.archetype.choice).toBe('troll');
  });

  it('throws JevHttpError carrying the status on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}),
    }));
    await expect(callJev({ apiKey: 'bad', modelId: 'm', state: {}, questions: {}, fetchImpl }))
      .rejects.toBeInstanceOf(JevHttpError);
    try {
      await callJev({ apiKey: 'bad', modelId: 'm', state: {}, questions: {}, fetchImpl });
    } catch (e) {
      expect(e.status).toBe(401);
      expect(e.message).toContain('unauthorized');
    }
  });
});

describe('parseAnswer', () => {
  const answers = (archetype, lean) => ({ archetype, lean });

  it('accepts a valid choice and keeps probabilities', () => {
    const got = parseAnswer(answers(
      { type: 'choice', choice: 'troll', probabilities: { troll: 0.62, thanh: 0.38 } },
    ), DEFAULT_LABELS);
    expect(got.choice).toBe('troll');
    expect(got.probabilities).toEqual({ troll: 0.62, thanh: 0.38 });
  });

  it('tolerates missing probabilities', () => {
    const got = parseAnswer(answers({ type: 'choice', choice: 'troll' }), DEFAULT_LABELS);
    expect(got.probabilities).toBeNull();
  });

  it('throws on a choice that is not in the label set', () => {
    expect(() => parseAnswer(answers({ type: 'choice', choice: 'khong_ton_tai' }), DEFAULT_LABELS))
      .toThrow(JevAnswerError);
  });

  it('throws when the archetype answer is missing entirely', () => {
    expect(() => parseAnswer({ lean: {} }, DEFAULT_LABELS)).toThrow(JevAnswerError);
  });

  it('collects every valid lean probability', () => {
    const got = parseAnswer(answers(
      { type: 'choice', choice: 'bo_do' },
      { proGov: { type: 'boolean', probability: 0.81 }, proChina: { type: 'boolean', probability: 0.44 } },
    ), DEFAULT_LABELS);
    expect(got.lean).toEqual({ proGov: 0.81, proChina: 0.44 });
  });

  it('drops a malformed lean without discarding the archetype', () => {
    const got = parseAnswer(answers(
      { type: 'choice', choice: 'bo_do' },
      {
        proGov: { type: 'boolean', probability: 0.81 },
        proChina: { type: 'boolean', probability: 3 },
        proUS: { type: 'score', score: 1 },
        antiGov: null,
      },
    ), DEFAULT_LABELS);
    expect(got.choice).toBe('bo_do');
    expect(got.lean).toEqual({ proGov: 0.81 });
  });

  it('returns an empty lean map when lean is absent', () => {
    const got = parseAnswer(answers({ type: 'choice', choice: 'troll' }), DEFAULT_LABELS);
    expect(got.lean).toEqual({});
  });
});
