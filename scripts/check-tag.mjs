#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'extension', 'manifest.json');

/**
 * Returns null when `tag` names the version in the manifest, or a message
 * explaining the disagreement.
 *
 * A release tag is the only thing naming the artifact that a user downloads, and
 * the version inside the extension is the only thing Chrome will show them. When
 * those disagree, every download is mislabeled in a way that is invisible until
 * someone tries to work out which build they have — so the release stops instead.
 */
export function tagProblem(tag, version) {
  if (!tag) return 'no tag given (pass one as an argument, or set GITHUB_REF_NAME)';

  // One leading `v` is convention; anything else is part of the tag and has to
  // match, or `v0.1.0-rc1` would be waved through as 0.1.0.
  const named = tag.replace(/^v/, '');
  if (named === version) return null;

  return `tag ${tag} does not match extension/manifest.json version ${version}`;
}

function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
  const { version } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const problem = tagProblem(tag, version);

  if (problem) {
    console.error(`✗ ${problem}`);
    console.error(`\nBump the version in extension/manifest.json, or re-tag.`);
    process.exit(1);
  }

  console.log(`✓ tag ${tag} matches the extension version ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
