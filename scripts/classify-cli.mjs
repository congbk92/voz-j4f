#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildState, buildQuestions, callJev, parseAnswer } from '../extension/lib/jev.js';
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

const member = JSON.parse(readFileSync(file, 'utf8'));
const state = buildState(member);
const questions = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);

console.log(`→ ${member.name} · ${state.posts.length} posts · ${state.posts.reduce((n, p) => n + p.length, 0)} chars\n`);

const answers = await callJev({ apiKey, modelId, state, questions });
const parsed = parseAnswer(answers, DEFAULT_LABELS);   // throws on an invented choice

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
