import { describe, it, expect, vi } from 'vitest';
import {
  buildState, buildQuestions, callJev, parseAnswer,
  GATEWAY_ENDPOINT, MAX_POSTS, MAX_POST_CHARS,
  JevHttpError, JevAnswerError,
  DEFAULT_RETRY_POLICY, resolveRetryPolicy, parseRetryAfterMs, computeRetryDelayMs,
  isRetryableJevError, gatewayErrorMessage,
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
    // Identity is the only way to observe rank-before-truncate: c, e, b and f all
    // cap at 800, so truncate-then-rank would yield b,c,e,f,g,d instead.
    expect(state.posts.map((p) => p[0])).toEqual(['c', 'e', 'b', 'f', 'g', 'd']);
    expect(state.posts[0]).toHaveLength(MAX_POST_CHARS);
    expect(state.posts[1]).toHaveLength(MAX_POST_CHARS);  // 1200-char post, truncated
    expect(state.posts[4]).toHaveLength(700);             // under the cap, survives whole
    expect(state.posts[5]).toHaveLength(50);
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

  it('builds one boolean per lean question, flat beside archetype', () => {
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    expect(Object.keys(q)).toHaveLength(1 + Object.keys(LEAN_QUESTIONS).length);
    for (const key of Object.keys(LEAN_QUESTIONS)) {
      expect(q[key].type).toBe('boolean');
      expect(typeof q[key].instructions).toBe('string');
    }
  });

  it('gives every question its own type discriminator, which is what the gateway validates', () => {
    // The nesting bug shipped past the suite because nothing asserted this: every
    // value in `questions` must carry a `type`, and the gateway 400s without it.
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    for (const v of Object.values(q)) {
      expect(['choice', 'score', 'boolean']).toContain(v.type);
      expect(typeof v.instructions).toBe('string');
    }
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
    expect(init.headers['ai-gateway-protocol-version']).toBe('0.0.1');
    expect(init.headers['ai-gateway-auth-method']).toBe('api-key');
    expect(init.headers['ai-model-id']).toBe('typesafe-ai/jev');
    expect(JSON.parse(init.body)).toEqual({
      state: { member: 'alice' }, questions: { archetype: {} }, providerOptions: {},
    });
    // A request that never settles would hold its queue slot forever, and
    // `enqueue`'s early return would then make that member un-enqueueable — by
    // force included. The call must therefore carry a timeout signal.
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

describe('retry policy', () => {
  it('resolves a partial policy over the defaults', () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    expect(resolveRetryPolicy({ maxAttempts: 2 }).maxAttempts).toBe(2);
    // Keys the caller did not name keep their default.
    expect(resolveRetryPolicy({ maxAttempts: 2 }).baseDelayMs).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
  });

  it('clamps values that would break the loop or the timer', () => {
    // A zero-attempt loop would silently return an empty answers map.
    expect(resolveRetryPolicy({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(resolveRetryPolicy({ maxAttempts: 99 }).maxAttempts).toBe(10);
    expect(resolveRetryPolicy({ maxAttempts: 2.7 }).maxAttempts).toBe(2);
    expect(resolveRetryPolicy({ baseDelayMs: -5 }).baseDelayMs).toBe(0);
    expect(resolveRetryPolicy({ requestTimeoutMs: 10 }).requestTimeoutMs).toBe(1000);
    expect(resolveRetryPolicy({ minAttemptMs: 0 }).minAttemptMs).toBe(1);
    // Non-numbers fall back rather than propagating NaN into AbortSignal.timeout.
    expect(resolveRetryPolicy({ maxAttempts: 'lots' }).maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it('keeps each ceiling above the one below it', () => {
    // Otherwise a deliberate maxDelay below the base would be clamped to a
    // value the caller never chose, and the budget below that.
    const p = resolveRetryPolicy({ baseDelayMs: 9000, maxDelayMs: 100, totalBudgetMs: 50 });
    expect(p.maxDelayMs).toBe(9000);
    expect(p.totalBudgetMs).toBe(9000);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
    expect(parseRetryAfterMs(' 20 ')).toBe(20000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('reads the HTTP-date form against the supplied clock', () => {
    const T = Date.UTC(2026, 8, 26, 7, 0, 0);
    expect(parseRetryAfterMs(new Date(T + 3000).toUTCString(), T)).toBe(3000);
  });

  it('returns null for anything it cannot read', () => {
    // Null is the caller's cue to fall back to exponential backoff, so it must
    // not be confused with "zero seconds, retry now".
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('   ')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs('-5')).toBeNull();
  });

  it('floors a date already in the past at zero', () => {
    const T = Date.UTC(2026, 8, 26, 7, 0, 0);
    expect(parseRetryAfterMs(new Date(T - 5000).toUTCString(), T)).toBe(0);
  });
});

describe('computeRetryDelayMs', () => {
  const err = (retryAfterMs = null) => new JevHttpError(429, 'busy', { retryAfterMs });

  it('backs off exponentially, jittered in the upper half of the nominal wait', () => {
    // The bounds, not just a point value: full jitter would admit ~0 here, which
    // fires straight back at a gateway that just asked us to slow down.
    expect([0, 1, 2].map((i) => computeRetryDelayMs(err(), i, DEFAULT_RETRY_POLICY, () => 1)))
      .toEqual([1000, 2000, 4000]);
    expect([0, 1, 2].map((i) => computeRetryDelayMs(err(), i, DEFAULT_RETRY_POLICY, () => 0)))
      .toEqual([500, 1000, 2000]);
  });

  it('caps the nominal backoff at maxDelayMs', () => {
    expect(computeRetryDelayMs(err(), 9, DEFAULT_RETRY_POLICY, () => 1)).toBe(8000);
  });

  it('lets Retry-After win and does not jitter it', () => {
    expect(computeRetryDelayMs(err(3000), 0, DEFAULT_RETRY_POLICY, () => 0)).toBe(3000);
  });

  it('refuses a wait longer than a queue slot may idle', () => {
    // Retrying early would burn the attempt and earn another 429.
    expect(computeRetryDelayMs(err(600000), 0, DEFAULT_RETRY_POLICY, () => 1)).toBeNull();
  });

  it('falls back to backoff for a non-HTTP error', () => {
    expect(computeRetryDelayMs(new Error('socket'), 0, DEFAULT_RETRY_POLICY, () => 1)).toBe(1000);
  });
});

describe('isRetryableJevError', () => {
  it('retries the transient failures', () => {
    expect(isRetryableJevError(new JevHttpError(429, 'busy'))).toBe(true);
    expect(isRetryableJevError(new JevHttpError(503, 'unavailable'))).toBe(true);
    // A network failure or this side's own abort is not a JevHttpError at all.
    expect(isRetryableJevError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableJevError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it('treats a client error as final', () => {
    // Retrying a bad key multiplies failed calls and delays the lastError the
    // chip and popup read.
    expect(isRetryableJevError(new JevHttpError(401, 'unauthorized'))).toBe(false);
    expect(isRetryableJevError(new JevHttpError(403, 'forbidden'))).toBe(false);
    expect(isRetryableJevError(new JevHttpError(400, 'bad request'))).toBe(false);
  });
});

describe('callJev retry', () => {
  const base = { apiKey: 'k', modelId: 'm', state: {}, questions: {} };
  const ANSWER = { answers: { archetype: { type: 'choice', choice: 'troll' } } };
  const failure = (status, retryAfter) => ({
    ok: false, status, text: async () => 'boom', json: async () => ({}),
    // Deliberately absent unless the case needs it: every fake in this suite is
    // header-less, and reading one must not throw.
    ...(retryAfter === undefined ? {} : { headers: { get: () => retryAfter } }),
  });
  const success = {
    ok: true, status: 200, json: async () => ANSWER, text: async () => JSON.stringify(ANSWER),
  };
  const scripted = (...responses) => {
    let i = 0;
    return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
  };
  const recorder = () => {
    const delays = [];
    return { delays, sleep: async (ms) => { delays.push(ms); } };
  };

  it('retries a 429 and returns the answers once the gateway recovers', async () => {
    const { delays, sleep } = recorder();
    const fetchImpl = scripted(failure(429), success);
    const answers = await callJev({ ...base, fetchImpl, sleep, random: () => 1 });

    expect(answers.archetype.choice).toBe('troll');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
  });

  it('waits as long as the gateway asked, not the backoff', async () => {
    const { delays, sleep } = recorder();
    await callJev({ ...base, fetchImpl: scripted(failure(429, '3'), success), sleep, random: () => 1 });
    expect(delays).toEqual([3000]);
  });

  it('gives up rather than retry early when the wait is too long', async () => {
    const { delays, sleep } = recorder();
    const fetchImpl = scripted(failure(429, '600'));
    await expect(callJev({ ...base, fetchImpl, sleep })).rejects.toBeInstanceOf(JevHttpError);
    // One call: retrying 8s into a 10-minute wait would only earn another 429.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('does not retry a 401', async () => {
    const { delays, sleep } = recorder();
    const fetchImpl = scripted(failure(401));
    await expect(callJev({ ...base, fetchImpl, sleep })).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('stops after maxAttempts and surfaces the last failure', async () => {
    const { delays, sleep } = recorder();
    const fetchImpl = scripted(failure(503));
    await expect(callJev({ ...base, fetchImpl, sleep, random: () => 1 }))
      .rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('honours a partial policy override', async () => {
    const { sleep } = recorder();
    const fetchImpl = scripted(failure(503));
    await expect(callJev({ ...base, fetchImpl, sleep, policy: { maxAttempts: 2 } })).rejects.toBeInstanceOf(JevHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('still attempts once when a policy clamps maxAttempts to zero', async () => {
    const { sleep } = recorder();
    const fetchImpl = scripted(failure(503));
    await expect(callJev({ ...base, fetchImpl, sleep, policy: { maxAttempts: 0 } })).rejects.toBeInstanceOf(JevHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops starting attempts once the budget is spent', async () => {
    const { sleep } = recorder();
    const fetchImpl = scripted(failure(503));
    // A clock that jumps past the budget on its second read: the first attempt
    // runs, and the loop must not start a second.
    let t = 0;
    const now = () => { const v = t; t += 100000; return v; };
    await expect(callJev({ ...base, fetchImpl, sleep, now })).rejects.toBeInstanceOf(JevHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets the caller refuse a retry and rethrows the real error', async () => {
    const { delays, sleep } = recorder();
    const fetchImpl = scripted(failure(429));
    const shouldRetry = vi.fn(async () => false);
    // The original error, not a cancellation sentinel: the caller already knows
    // why it refused and still needs the failure to record.
    await expect(callJev({ ...base, fetchImpl, sleep, shouldRetry, random: () => 1 }))
      .rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(shouldRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, delayMs: 1000 });
  });

  it('never consults the caller for a final attempt', async () => {
    const { sleep } = recorder();
    const shouldRetry = vi.fn(async () => true);
    await expect(callJev({
      ...base, fetchImpl: scripted(failure(503)), sleep, shouldRetry, policy: { maxAttempts: 2 },
    })).rejects.toBeInstanceOf(JevHttpError);
    // One retry follows attempt 1; there is nothing to ask before giving up.
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });
});

describe('gatewayErrorMessage', () => {
  it('pulls the gateway\'s own sentence out of the error envelope', () => {
    // The real body from an upstream-demand 429. This line is the only thing that
    // says the provider is busy rather than the key being wrong.
    const body = JSON.stringify({
      error: {
        message: 'The upstream provider is currently experiencing high demand. Please retry shortly.',
        type: 'rate_limit_exceeded',
      },
    });
    expect(gatewayErrorMessage(new JevHttpError(429, body)))
      .toBe('The upstream provider is currently experiencing high demand. Please retry shortly.');
  });

  it('returns null when there is no such envelope to read', () => {
    expect(gatewayErrorMessage(new JevHttpError(500, 'Internal Server Error'))).toBeNull();
    expect(gatewayErrorMessage(new JevHttpError(500, ''))).toBeNull();
    expect(gatewayErrorMessage(new JevHttpError(500, '{"error":{}}'))).toBeNull();
    expect(gatewayErrorMessage(new JevHttpError(500, '{"error":{"message":"   "}}'))).toBeNull();
    expect(gatewayErrorMessage(new Error('socket hang up'))).toBeNull();
  });
});

describe('parseAnswer', () => {
  // `questions` is flat, so lean answers sit beside archetype at the top level
  // rather than nested under a `lean` key. Spreading mirrors that shape.
  const answers = (archetype, lean = {}) => ({ archetype, ...lean });

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
