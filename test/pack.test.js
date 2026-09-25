import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pack, createZip } from '../scripts/pack.mjs';

function scaffold(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-pack-'));
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
  name: 'x',
  // Deliberately not a version any code hardcodes: if the artifact is named from
  // a constant rather than the manifest, these tests say so.
  version: '9.9.9',
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [{ matches: ['https://voz.vn/*'], js: ['content.js'], css: ['content.css'] }],
  web_accessible_resources: [{ resources: ['lib/*.js'], matches: ['https://voz.vn/*'] }],
};

// A fixture with content worth compressing, an empty file, and a non-ASCII one —
// the three shapes a hand-rolled zip writer is most likely to get wrong.
const FILES = {
  'background.js': 'export const x = 1;\n'.repeat(200),
  'content.js': '',
  'content.css': '.a{color:red}',
  'lib/voz.js': '// nhãn — dán nhãn thành viên\n',
};

/** A scratch dir that cleans itself up, so a failing assertion cannot leak it. */
function scratch(fn) {
  const dirs = [];
  const make = () => {
    const d = mkdtempSync(join(tmpdir(), 'jev-pack-out-'));
    dirs.push(d);
    return d;
  };
  try {
    return fn(make);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

const listZip = (zip) =>
  execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');

const testZip = (zip) => execFileSync('unzip', ['-t', zip], { encoding: 'utf8' });

describe('pack', () => {
  it('writes an archive that unzip reports as intact', () => {
    const ext = scaffold(FILES, BASE);
    try {
      scratch((make) => {
        const dist = make();
        const { zipPath } = pack({ extDir: ext, distDir: dist });

        expect(existsSync(zipPath)).toBe(true);
        // The closest stand-in for "Chrome will accept this": a CRC-checked read
        // of every entry. A malformed central directory fails here.
        expect(testZip(zipPath)).toContain('No errors detected');
      });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it('roots the archive at manifest.json rather than nesting it in a folder', () => {
    // A zip with a top-level directory still extracts to a loadable folder, but
    // "Load unpacked" on the extraction dir then fails, because Chrome wants
    // manifest.json at the root of the folder it is handed.
    const ext = scaffold(FILES, BASE);
    try {
      scratch((make) => {
        const { zipPath } = pack({ extDir: ext, distDir: make() });
        const names = listZip(zipPath);

        expect(names).toContain('manifest.json');
        expect(names).toContain('lib/voz.js');
        expect(names.some((n) => n.startsWith('extension/'))).toBe(false);
        expect(names.some((n) => n.startsWith('/'))).toBe(false);
      });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it("names the artifact from the manifest's version", () => {
    const ext = scaffold(FILES, BASE);
    try {
      scratch((make) => {
        const { zipPath } = pack({ extDir: ext, distDir: make() });
        expect(basename(zipPath)).toBe('voz-j4f-9.9.9.zip');
      });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it('round-trips every file byte for byte, including an empty one', () => {
    const ext = scaffold(FILES, BASE);
    try {
      scratch((make) => {
        const dist = make();
        const { zipPath } = pack({ extDir: ext, distDir: dist });
        const out = make();
        execFileSync('unzip', ['-q', zipPath, '-d', out]);

        for (const [rel, content] of Object.entries(FILES)) {
          expect(readFileSync(join(out, rel), 'utf8'), rel).toBe(content);
        }
      });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it('produces identical bytes for identical input', () => {
    // Fixed timestamps in the archive are what make this hold, and what let a
    // release artifact be checked against a rebuild of the tag.
    const ext = scaffold(FILES, BASE);
    try {
      scratch((make) => {
        const a = pack({ extDir: ext, distDir: make() }).zipPath;
        const b = pack({ extDir: ext, distDir: make() }).zipPath;
        expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
      });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it('refuses to pack an extension Chrome would not load', () => {
    const ext = scaffold({ 'background.js': '' }, BASE);
    try {
      scratch((make) => {
        const dist = make();
        expect(() => pack({ extDir: ext, distDir: dist })).toThrow(/validation failed/i);
        // The failure has to be a refusal, not a half-written artifact: a zip in
        // dist/ after a red run is how a broken extension gets uploaded anyway.
        expect(existsSync(join(dist, 'voz-j4f-9.9.9.zip'))).toBe(false);
      });
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });
});

describe('createZip', () => {
  it('stores a file rather than deflating it when deflating would grow it', () => {
    // zlib emits a fixed-cost block even for zero bytes, so a small or empty
    // entry written with method 8 is strictly larger than the original. Method 0
    // is the reason an empty content.js does not inflate the artifact.
    const entries = [{ name: 'empty.js', data: Buffer.alloc(0) }];
    const zip = createZip(entries);
    const method = zip.readUInt16LE(8); // compression method in the local header

    expect(method).toBe(0);
    expect(zip.readUInt32LE(18)).toBe(0); // compressed size
  });

  it('deflates a file that is worth compressing', () => {
    const entries = [{ name: 'big.js', data: Buffer.from('const x = 1;\n'.repeat(500)) }];
    const zip = createZip(entries);

    expect(zip.readUInt16LE(8)).toBe(8);
    expect(zip.readUInt32LE(18)).toBeLessThan(zip.readUInt32LE(22));
  });
});
