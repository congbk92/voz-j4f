export const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const MAX_POSTS = 6;
export const MAX_POST_CHARS = 800;
const MAX_THREADS = 5;

/**
 * The one retry policy, here because this is the only module that talks to the
 * gateway. Retrying a transient gateway fault is part of the protocol, not a
 * caller's decision — the CLI and the options page's test button had no retry at
 * all precisely because each caller had to remember to add one.
 *
 * Everything is overridable per call, and `config.js` derives its user-facing
 * `retry*` keys from this object so the numbers have exactly one definition.
 */
export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 4,           // one attempt plus three retries
  baseDelayMs: 1000,        // nominal first backoff; doubles per retry
  maxDelayMs: 8000,         // per-delay ceiling, and the ceiling on Retry-After
  totalBudgetMs: 45000,     // wall clock for the whole sequence, requests included
  requestTimeoutMs: 30000,  // per-attempt abort
  minAttemptMs: 5000,       // never start an attempt with less budget than this
};

const RETRY_ATTEMPT_CEILING = 10;

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Merge a partial policy over the defaults and clamp it. Called on every
 * `callJev`, so a bad env var or a hand-edited config record cannot produce a
 * zero-attempt loop or a negative timeout.
 */
export function resolveRetryPolicy(partial = {}) {
  const d = DEFAULT_RETRY_POLICY;
  const baseDelayMs = Math.max(0, finite(partial.baseDelayMs, d.baseDelayMs));
  // Each ceiling must admit the one below it, or the clamp would silently
  // contradict a value the user set deliberately.
  const maxDelayMs = Math.max(baseDelayMs, finite(partial.maxDelayMs, d.maxDelayMs));
  const totalBudgetMs = Math.max(maxDelayMs, finite(partial.totalBudgetMs, d.totalBudgetMs));
  return {
    maxAttempts: Math.min(RETRY_ATTEMPT_CEILING,
      Math.max(1, Math.trunc(finite(partial.maxAttempts, d.maxAttempts)))),
    baseDelayMs,
    maxDelayMs,
    totalBudgetMs,
    requestTimeoutMs: Math.max(1000, finite(partial.requestTimeoutMs, d.requestTimeoutMs)),
    minAttemptMs: Math.max(1, finite(partial.minAttemptMs, d.minAttemptMs)),
  };
}

/**
 * Flat `retry*` keys -> policy, coercing the strings they arrive as.
 *
 * The worker no longer uses this: it retries by putting a failed member back in
 * its queue, so it calls `callJev` with `maxAttempts: 1`. This is for callers
 * that have no queue of their own — the CLI, driven by `JEV_RETRY_*` in
 * `.env.local`, which is where the retry policy is configurable now.
 */
export function retryPolicyFromConfig(cfg = {}) {
  // Coerced, because these arrive as strings from the options page's number
  // inputs and from `.env.local`. An empty field is "unset", not zero — Number('')
  // is 0, which would clamp a deliberate setting down to one attempt.
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  return resolveRetryPolicy({
    maxAttempts: num(cfg.retryMaxAttempts),
    baseDelayMs: num(cfg.retryBaseDelayMs),
    maxDelayMs: num(cfg.retryMaxDelayMs),
    totalBudgetMs: num(cfg.retryTotalBudgetMs),
    requestTimeoutMs: num(cfg.requestTimeoutMs),
  });
}

export class JevHttpError extends Error {
  constructor(status, body, { retryAfterMs = null } = {}) {
    super(`Gateway returned ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'JevHttpError';
    this.status = status;
    this.body = body;
    // Deliberately not `RETRY_AFTER_MS` from config.js: that is the hour-long
    // cooldown after a failure, this is the gateway's own "wait N seconds".
    this.retryAfterMs = retryAfterMs;
  }
}

export class JevAnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JevAnswerError';
  }
}

/**
 * RFC 9110 `Retry-After`: either delta-seconds (`Retry-After: 20`) or an
 * HTTP-date. Null when absent or unparseable, which is the caller's cue to fall
 * back to exponential backoff.
 *
 * The date form is wall-clock by definition, so `Date.now()` is correct here —
 * unlike the retry budget, which uses a monotonic clock.
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  // Delta-seconds is 1*DIGIT — never signed. A negative has to be rejected here
  // rather than left to Date.parse, which reads `-5` as a year and would hand
  // back "in the past", i.e. retry immediately.
  if (/^-?\d+$/.test(s)) return Number(s) < 0 ? null : Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

/**
 * The wait before retry `retryIndex` (0-based).
 *
 * `Retry-After` wins when the gateway sent one: that is the server saying when
 * it will be ready, so it is used as given and *not* jittered — jitter could
 * only make us early.
 *
 * Returns `null` when the gateway asked for longer than a queue slot may idle.
 * Retrying early would burn the attempt and earn another 429, so the caller
 * stops and lets the caller's own cooldown own it.
 */
export function computeRetryDelayMs(error, retryIndex, policy = DEFAULT_RETRY_POLICY, random = Math.random) {
  const p = resolveRetryPolicy(policy);
  const hinted = error instanceof JevHttpError ? error.retryAfterMs : null;
  if (typeof hinted === 'number') return hinted > p.maxDelayMs ? null : hinted;

  const nominal = Math.min(p.baseDelayMs * 2 ** retryIndex, p.maxDelayMs);
  // Equal jitter — [nominal/2, nominal] — not full jitter. Full jitter admits
  // ~0, which fires straight back at a gateway that just asked us to slow down;
  // this keeps a floor while still de-syncing the worker's two queue slots.
  return Math.round(nominal / 2 + random() * (nominal / 2));
}

/**
 * Spec §8: `429` and network failures retry; a 5xx is the same class of
 * transient server fault, and an abort is this side's own timeout, which is a
 * network failure by another name. Everything else is final: a client error
 * will not heal on another attempt, so retrying a `401`/`403` only multiplies
 * failed calls against the gateway and delays the `lastError` the UI reads.
 */
export function isRetryableJevError(e) {
  if (!(e instanceof JevHttpError)) return true;
  return e.status === 429 || e.status >= 500;
}

/**
 * The gateway's own human sentence, when it sent one. Its 429 body carries
 * `{"error":{"message":"The upstream provider is currently experiencing high
 * demand. Please retry shortly."}}`, which is far more useful than the truncated
 * JSON that `JevHttpError.message` carries — and it is the only thing that
 * distinguishes an upstream provider being busy from this key being wrong.
 * Null when the body is not that shape.
 */
export function gatewayErrorMessage(error) {
  if (!(error instanceof JevHttpError)) return null;
  try {
    const message = JSON.parse(error.body)?.error?.message;
    return typeof message === 'string' && message.trim() ? message.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The fakes in the test suite are plain objects with no `headers` at all, so
 * this has to survive a missing (or hostile) header bag rather than throw a
 * TypeError in place of the JevHttpError the caller is waiting for.
 */
function headerValue(res, name) {
  try {
    return res?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Monotonic: the budget is a duration, and a wall clock that steps forward
// under load would expire it early (the same reason test/background.test.js
// waits on performance.now()).
const defaultNow = () => performance.now();

/** At most 6 posts, ranked by original length, then truncated. */
export function buildState(member) {
  const posts = [...(member.posts || [])]
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_POSTS)
    .map((p) => p.text.slice(0, MAX_POST_CHARS));

  const state = { member: member.name, posts };
  if (member.threads && member.threads.length) state.threads = member.threads.slice(0, MAX_THREADS);
  if (member.profile && member.profile.joined) state.joined = member.profile.joined;
  if (member.profile && member.profile.postCount != null) state.postCount = member.profile.postCount;
  return state;
}

export function buildQuestions(labels, leanQuestions, archetypeInstructions) {
  const criteria = {};
  for (const l of labels) criteria[l.key] = l.description;

  // FLAT, not nested. `questions` is a map of question id -> question, and each
  // value must carry its own `type` discriminator. Nesting the lean booleans under
  // a `lean` key makes the gateway read `questions.lean` as a question with no
  // `type` and answer 400 "Invalid discriminator value … path: questions.lean.type".
  const questions = {
    archetype: { type: 'choice', instructions: archetypeInstructions, criteria },
  };
  for (const [key, instructions] of Object.entries(leanQuestions)) {
    questions[key] = { type: 'boolean', instructions };
  }
  return questions;
}

/**
 * One classification, retried on the transient failures `isRetryableJevError`
 * names and bounded by `policy`.
 *
 * The awaits are deliberate: every call here is awaited from the worker's
 * `runOne`, so a backing-off member idles *its own* queue slot while the other
 * slot keeps draining the queue. Do not turn the sleep into a detached timer.
 */
export async function callJev({
  apiKey, modelId, state, questions,
  fetchImpl = fetch, endpoint = GATEWAY_ENDPOINT,
  policy,
  // Injection seams. The suite has no fake timers and no injectable clock, so a
  // recording `sleep` and a fixed `random` are the only way to assert backoff
  // behaviour without waiting for it.
  sleep = defaultSleep, random = Math.random, now = defaultNow,
  // async ({ attempt, maxAttempts, delayMs, error }) => boolean. Called once per
  // retry, so a caller can log it and can still refuse it — the worker re-reads
  // its master toggle here, because a disable during a backoff would otherwise
  // let the remaining attempts spend.
  shouldRetry = null,
}) {
  const p = resolveRetryPolicy(policy);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // Captured from the installed SDK's fetch, not read from its source. The
    // provider factory adds the protocol and auth-method headers; the
    // evaluation-model class does not, and omitting them earns a
    // `400 Unsupported gateway protocol version` rather than a missing-header
    // error, which is slow to diagnose from the message alone.
    'ai-evaluation-model-specification-version': '4',
    'ai-gateway-protocol-version': '0.0.1',
    'ai-gateway-auth-method': 'api-key',
    'ai-model-id': modelId,
  };
  const body = JSON.stringify({ state, questions, providerOptions: {} });

  const startedAt = now();
  let lastError = null;

  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    // The first attempt always runs; later ones only if there is budget enough
    // to be worth starting. Shrinking the per-attempt timeout to what is left is
    // what makes the budget real — four attempts at a flat 30s each could
    // otherwise hang for two minutes against a gateway that never answers.
    const remaining = p.totalBudgetMs - (now() - startedAt);
    if (attempt > 1 && remaining <= 0) break;
    const attemptTimeout = Math.min(p.requestTimeoutMs, Math.max(remaining, p.minAttemptMs));

    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body,
        // Without this, a request that never settles holds its queue slot
        // forever and makes that member permanently un-enqueueable, including by
        // force. A timeout is also the honest bound for a classification call.
        signal: AbortSignal.timeout(attemptTimeout),
      });

      if (res.ok) {
        const json = await res.json();
        return json.answers || {};
      }
      const text = await res.text().catch(() => '');
      throw new JevHttpError(res.status, text, {
        retryAfterMs: parseRetryAfterMs(headerValue(res, 'retry-after')),
      });
    } catch (e) {
      lastError = e;
      if (attempt >= p.maxAttempts || !isRetryableJevError(e)) throw e;

      const delayMs = computeRetryDelayMs(e, attempt - 1, p, random);
      if (delayMs === null) throw e;   // asked to wait longer than we may hold a slot

      if (shouldRetry) {
        const go = await shouldRetry({ attempt, maxAttempts: p.maxAttempts, delayMs, error: e });
        if (!go) throw e;
      }
      await sleep(delayMs);
    }
  }

  // Exhausted the budget rather than the attempts: the last real failure is the
  // honest thing to report, not a synthetic error invented here.
  throw lastError ?? new JevHttpError(0, 'retry budget exhausted before any attempt');
}

/** Validate a raw answers map. Throws rather than caching an invented label. */
export function parseAnswer(answers, labels) {
  const a = answers && answers.archetype;
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') {
    throw new JevAnswerError('missing archetype choice answer');
  }
  if (!labels.some((l) => l.key === a.choice)) {
    throw new JevAnswerError(`choice not in label set: ${a.choice}`);
  }

  // The lean answers sit beside `archetype` at the top level, because `questions`
  // is flat. Every non-archetype question we send is a boolean lean axis, so
  // anything that parses as one is collected.
  const lean = {};
  for (const [key, v] of Object.entries(answers || {})) {
    if (key === 'archetype') continue;
    if (v && v.type === 'boolean'
        && typeof v.probability === 'number'
        && v.probability >= 0 && v.probability <= 1) {
      lean[key] = v.probability;
    }
  }

  return {
    choice: a.choice,
    probabilities: a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null,
    lean,
  };
}
