#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  buildState, buildQuestions, callJev, parseAnswer,
  JevHttpError, gatewayErrorMessage, retryPolicyFromConfig,
} from '../extension/lib/jev.js';
import { DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS } from '../extension/lib/labels.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(ROOT, '.env.local') });

const file = process.argv[2] || resolve(ROOT, 'example-member.json');
const apiKey = process.env.AI_GATEWAY_API_KEY;
const modelId = process.argv[3] || 'typesafe-ai/jev';

if (!apiKey) {
  console.error('✗ AI_GATEWAY_API_KEY is not set. Put it in .env.local');
  process.exit(1);
}

/**
 * The same knobs the extension's options page writes, read from `.env.local`
 * under a `JEV_` prefix. Only the keys actually present are passed on, because
 * spreading `undefined` over the policy defaults would blank them.
 */
const ENV_KEYS = {
  retryMaxAttempts: 'JEV_RETRY_MAX_ATTEMPTS',
  retryBaseDelayMs: 'JEV_RETRY_BASE_DELAY_MS',
  retryMaxDelayMs: 'JEV_RETRY_MAX_DELAY_MS',
  retryTotalBudgetMs: 'JEV_RETRY_TOTAL_BUDGET_MS',
  requestTimeoutMs: 'JEV_REQUEST_TIMEOUT_MS',
};

function policyFromEnv(env) {
  const cfg = {};
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    const value = env[name];
    if (value != null && value !== '') cfg[key] = value;
  }
  return retryPolicyFromConfig(cfg);
}

/**
 * The gateway's own sentence when it sent one — for a 429 it is
 * "The upstream provider is currently experiencing high demand. Please retry
 * shortly.", which says far more than the truncated JSON behind it.
 */
function failureText(e) {
  if (e instanceof JevHttpError) {
    const hint = e.status === 401 || e.status === 403
      ? 'check AI_GATEWAY_API_KEY in .env.local'
      : e.status === 429
        ? 'the gateway is rate limiting; try again shortly'
        : e.status >= 500 ? 'the gateway failed server-side; try again shortly' : null;
    return [`HTTP ${e.status}`, gatewayErrorMessage(e) || e.message, hint].filter(Boolean).join(' — ');
  }
  if (e && e.name === 'TimeoutError') return 'the gateway did not answer within the request timeout';
  return (e && e.message) || String(e);
}

// A stack trace here is noise: every failure below is one the user can act on,
// and the file/argv that caused it is already on screen.
let member;
try {
  member = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✗ cannot read ${file}: ${e.message}`);
  process.exit(1);
}

const state = buildState(member);
const questions = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);

console.log(`→ ${member.name} · ${state.posts.length} posts · ${state.posts.reduce((n, p) => n + p.length, 0)} chars\n`);

let answers;
try {
  answers = await callJev({
    apiKey,
    modelId,
    state,
    questions,
    policy: policyFromEnv(process.env),
    // Unlike the extension there is nothing to gate on — this invocation is the
    // user asking — but a silent multi-second gap reads as a hang, so each retry
    // says what it is waiting for. Deliberately terse: the full diagnosis is
    // printed once, at the end, if it never recovers. stderr, so the report on
    // stdout stays clean.
    shouldRetry: ({ attempt, maxAttempts, delayMs, error }) => {
      const why = error instanceof JevHttpError
        ? `HTTP ${error.status}`
        : (error && error.name === 'TimeoutError' ? 'timeout' : (error && error.message) || 'failed');
      console.warn(`  ↻ attempt ${attempt}/${maxAttempts} failed (${why}); retrying in ${Math.round(delayMs)}ms`);
      return true;
    },
  });
} catch (e) {
  console.error(`✗ ${failureText(e)}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseAnswer(answers, DEFAULT_LABELS);   // throws on an invented choice
} catch (e) {
  // Previously this escaped as an unhandled rejection with the same stack trace
  // as a gateway failure. Print what the model actually said instead.
  console.error(`✗ ${e.message}`);
  console.error(`  raw answers: ${JSON.stringify(answers).slice(0, 400)}`);
  process.exit(1);
}

const label = DEFAULT_LABELS.find((l) => l.key === parsed.choice);
console.log(`  ${label.label}  (${label.key})`);
if (parsed.probabilities) {
  const top = Object.entries(parsed.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [k, p] of top) console.log(`    ${(p * 100).toFixed(0).padStart(3)}%  ${k}`);
}
if (Object.keys(parsed.lean).length) {
  console.log('\n  lean:');
  for (const [k, p] of Object.entries(parsed.lean)) {
    console.log(`    ${(p * 100).toFixed(0).padStart(3)}%  ${k}`);
  }
}
console.log(`\n  raw answers: ${JSON.stringify(answers).slice(0, 400)}`);
