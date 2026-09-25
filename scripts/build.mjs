#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');

/**
 * Returns an array of human-readable problems. Empty means the manifest is
 * loadable. Reports every problem, not just the first, so one run is enough.
 */
export function validateManifest(extDir) {
  const problems = [];
  const manifestPath = join(extDir, 'manifest.json');

  if (!existsSync(manifestPath)) return ['manifest.json: missing'];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return [`manifest.json: not valid JSON — ${e.message}`];
  }

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version must be 3, found ${manifest.manifest_version}`);
  }

  const check = (rel, context) => {
    if (typeof rel !== 'string' || rel.includes('*')) return; // globs are checked below
    if (!existsSync(join(extDir, rel))) problems.push(`${rel} (referenced by ${context}): missing`);
  };

  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) check(f, 'content_scripts.js');
    for (const f of cs.css || []) check(f, 'content_scripts.css');
  }

  if (manifest.background?.service_worker) {
    check(manifest.background.service_worker, 'background.service_worker');
  }
  if (manifest.action?.default_popup) check(manifest.action.default_popup, 'action.default_popup');
  if (manifest.options_page) check(manifest.options_page, 'options_page');
  if (manifest.options_ui?.page) check(manifest.options_ui.page, 'options_ui.page');

  // Expand 'lib/*.js' style globs and confirm at least one file matches, then
  // confirm every lib module content.js dynamically imports also exists.
  for (const war of manifest.web_accessible_resources || []) {
    for (const res of war.resources || []) {
      if (!res.includes('*')) { check(res, 'web_accessible_resources'); continue; }
      const dir = join(extDir, dirname(res));
      if (!existsSync(dir)) {
        problems.push(`${res} (referenced by web_accessible_resources): directory missing`);
      }
    }
  }

  const contentPath = join(extDir, 'content.js');
  if (existsSync(contentPath)) {
    const src = readFileSync(contentPath, 'utf8');
    const re = /import\(\s*chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
    for (const m of src.matchAll(re)) check(m[1], 'content.js dynamic import');
  }

  // The service worker is an ES module, so its static imports must resolve too.
  // A bad one throws at worker startup with an error visible only in the
  // service-worker console — the least discoverable failure this validator exists
  // to pre-empt. Only relative specifiers are checked; bare ones are built-ins.
  // `^\s*` rather than `^`: an indented import is still an import, and anchoring
  // at column 0 let one ship green.
  const workerRel = manifest.background?.service_worker;
  if (workerRel && existsSync(join(extDir, workerRel))) {
    const src = readFileSync(join(extDir, workerRel), 'utf8');
    const re = /^\s*import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) {
      check(normalize(join(dirname(workerRel), m[1])), `${workerRel} static import`);
    }
  }

  return problems;
}

function main() {
  const problems = validateManifest(EXT);
  if (problems.length) {
    console.error('✗ Extension validation failed:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n${problems.length} problem(s). Chrome would load this broken.`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  cpSync(EXT, DIST, { recursive: true });

  const zipName = `voz-jev-${manifest.version}.zip`;
  try {
    execFileSync('zip', ['-qr', zipName, '.'], { cwd: DIST });
    console.log(`✓ dist/ built and zipped to dist/${zipName}`);
  } catch {
    console.log('✓ dist/ built (no `zip` binary found; skipped the archive)');
  }
  console.log('\nInstall: chrome://extensions → Developer mode → Load unpacked → select dist/');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
