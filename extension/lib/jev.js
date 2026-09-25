export const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const MAX_POSTS = 6;
export const MAX_POST_CHARS = 800;
const MAX_THREADS = 5;

export class JevHttpError extends Error {
  constructor(status, body) {
    super(`Gateway returned ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'JevHttpError';
    this.status = status;
    this.body = body;
  }
}

export class JevAnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JevAnswerError';
  }
}

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

export async function callJev({ apiKey, modelId, state, questions, fetchImpl = fetch, endpoint = GATEWAY_ENDPOINT }) {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
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
    },
    body: JSON.stringify({ state, questions, providerOptions: {} }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new JevHttpError(res.status, body);
  }

  const json = await res.json();
  return json.answers || {};
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
