import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '../scripts/build.mjs';

function scaffold(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-build-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

const BASE = {
  manifest_version: 3,
  name: 'x', version: '1.0.0',
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [{ matches: ['https://voz.vn/*'], js: ['content.js'], css: ['content.css'] }],
  web_accessible_resources: [{ resources: ['lib/*.js'], matches: ['https://voz.vn/*'] }],
};

describe('validateManifest', () => {
  it('passes on a complete extension', () => {
    const dir = scaffold({
      'background.js': '', 'content.js': '', 'content.css': '', 'lib/voz.js': '',
    }, BASE);
    try {
      expect(validateManifest(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports every missing file at once, not just the first', () => {
    // content.js must be present for the dynamic-import branch to be reachable:
    // it is the only branch that can name a concrete lib module (lib/voz.js).
    const dir = scaffold({
      'background.js': '',
      'content.js': "import(chrome.runtime.getURL('lib/voz.js'));",
    }, BASE);
    try {
      const errors = validateManifest(dir);
      expect(errors).toHaveLength(3);
      expect(errors.join('\n')).toContain('content.js');
      expect(errors.join('\n')).toContain('content.css');
      expect(errors.join('\n')).toContain('lib/voz.js');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects manifest_version 2', () => {
    const dir = scaffold({
      'background.js': '', 'content.js': '', 'content.css': '',
    }, { ...BASE, manifest_version: 2 });
    try {
      expect(validateManifest(dir).join('\n')).toContain('manifest_version must be 3');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe('version format', () => {
    const withVersion = (version) => {
      const dir = scaffold({
        'background.js': '', 'content.js': '', 'content.css': '', 'lib/voz.js': '',
      }, { ...BASE, version });
      try {
        return validateManifest(dir).join('\n');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };

    it('accepts what Chrome accepts', () => {
      for (const v of ['1', '0.0.2', '1.2.3.4', '0', '65535.65535']) {
        expect(withVersion(v)).not.toContain('version must be');
      }
    });

    it('rejects a v-prefixed version, which is what a hand-edit bumps to', () => {
      // The tag carries the `v`; the manifest must not. A `v0.0.2` here passes
      // every file check and then fails the release tag comparison, which reads
      // as "v0.0.2 does not match v0.0.2" and is impossible to diagnose from the
      // error alone — so it is caught here instead.
      expect(withVersion('v0.0.2')).toContain('version must be');
    });

    it('rejects the other shapes Chrome refuses to load', () => {
      for (const v of ['1.2.3.4.5', '1.0.0-rc1', '1.0.0 ', '01.2.3', '1.2.x', '', 1.2]) {
        expect(withVersion(v)).toContain('version must be');
      }
    });

    it('rejects a part above 65535', () => {
      expect(withVersion('65536.0.0')).toContain('version must be');
      expect(withVersion('1.999999')).toContain('version must be');
    });
  });

  it('checks the popup and options pages too, not just scripts', () => {
    const dir = scaffold({
      'background.js': '', 'content.js': '', 'content.css': '', 'lib/voz.js': '',
    }, { ...BASE, action: { default_popup: 'popup.html' }, options_page: 'options.html' });
    try {
      const errors = validateManifest(dir).join('\n');
      expect(errors).toContain('action.default_popup');
      expect(errors).toContain('options_page');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("checks the service worker's static imports too", () => {
    const dir = scaffold({
      'content.js': '',
      'content.css': '',
      'background.js': "import { createConfig } from './lib/config.js';\nimport './lib/missing.js';",
    }, BASE);
    try {
      const errors = validateManifest(dir).join('\n');
      expect(errors).toContain('lib/config.js');
      expect(errors).toContain('lib/missing.js');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports an indented static import, which the column-0 scan let ship', () => {
    // `^import` with the `m` flag matches only column 0, so this exact file —
    // indented, and so indented in real code whenever it sits inside a block or a
    // wrapped import list — validated green and then threw at worker startup.
    const dir = scaffold({
      'content.js': '',
      'content.css': '',
      'background.js': "const x = 1;\nif (x) {\n  import './lib/indented-gone.js';\n}\n",
    }, BASE);
    try {
      const errors = validateManifest(dir).join('\n');
      expect(errors).toContain('lib/indented-gone.js');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-build-'));
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    try {
      expect(validateManifest(dir).join('\n')).toContain('not valid JSON');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
