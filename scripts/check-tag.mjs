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
 *
 * The tag is the manifest version verbatim, which is also why it carries no `v`:
 * the manifest version has to satisfy Chrome's format (bare dot-separated
 * integers), so making the tag the same string means there is no transformation
 * between the two and nothing to get wrong. An earlier version stripped a
 * leading `v`, which made a manifest that *did* say `v0.0.2` fail as
 * "v0.0.2 does not match v0.0.2".
 */
export function tagProblem(tag, version) {
  if (!tag) return 'no tag given (pass one as an argument, or set GITHUB_REF_NAME)';

  if (tag === version) return null;

  // The mistake worth naming, because the generic message reads as nonsense when
  // it happens: a `v` on the tag is invisible next to a version that also has one.
  if (tag === `v${version}`) {
    return `tag ${tag} does not match extension/manifest.json version ${version} — drop the leading "v"; tags are the version on its own`;
  }

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
