#!/usr/bin/env node
import { cpSync, readFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { validateManifest } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');

// 1980-01-01 00:00:00, the DOS epoch, which is what zip dates count from.
// Pinned rather than stamped with the current time so that the same source packs
// to the same bytes — that is what lets a release artifact be checked against a
// rebuild of its tag. Timestamps would make every build differ.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file under `dir`, as zip entries with posix-relative names. */
function collect(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) collect(abs, base, out);
    else out.push({ name: relative(base, abs).split(sep).join('/'), data: readFileSync(abs) });
  }
  return out;
}

/**
 * Builds a zip archive in memory. Written out longhand against the spec rather
 * than shelling out to `zip`, which is not installed everywhere this runs — the
 * build silently skipped the archive for want of that binary, which is how a
 * release can go green with no artifact attached to it.
 *
 * Only file entries are written. Chrome and unzip both infer directories, so
 * directory entries would add bytes and a chance to get something wrong.
 */
export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const utf8Names = 0x0800; // tell the reader the names are UTF-8, not CP437

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    // Deflate carries a fixed overhead, so for a small or empty entry it makes
    // the archive bigger than the file. Store those instead.
    const compress = deflated.length < data.length;
    const body = compress ? deflated : data;
    const method = compress ? 8 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header
    header.writeUInt16LE(20, 4);         // version needed to extract
    header.writeUInt16LE(utf8Names, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);         // no extra field
    local.push(header, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory header
    dir.writeUInt16LE(20, 4);         // version made by
    dir.writeUInt16LE(20, 6);         // version needed to extract
    dir.writeUInt16LE(utf8Names, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);         // no extra field
    dir.writeUInt16LE(0, 32);         // no comment
    dir.writeUInt16LE(0, 34);         // disk number
    dir.writeUInt16LE(0, 36);         // internal attributes
    dir.writeUInt32LE(0, 38);         // external attributes
    dir.writeUInt32LE(offset, 42);    // where this entry's local header starts
    central.push(dir, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk holding the central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);    // where the central directory starts
  eocd.writeUInt16LE(0, 20);         // no comment

  return Buffer.concat([...local, centralBuf, eocd]);
}

/**
 * Validates the extension, copies it to `distDir` as a load-unpacked folder, and
 * writes the release archive beside it. Throws rather than warning if the
 * extension is unloadable or the archive cannot be written, so that a release
 * can never attach nothing.
 */
export function pack({ extDir = EXT, distDir = DIST } = {}) {
  const problems = validateManifest(extDir);
  if (problems.length) {
    const err = new Error(
      `extension validation failed (${problems.length} problem(s)):\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
    );
    err.problems = problems;
    throw err;
  }

  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  const entries = collect(extDir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const zip = createZip(entries);

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  cpSync(extDir, distDir, { recursive: true });

  // Written after the copy, so the archive is never one of its own inputs.
  const zipPath = join(distDir, `voz-j4f-${manifest.version}.zip`);
  writeFileSync(zipPath, zip);

  if (!existsSync(zipPath) || statSync(zipPath).size === 0) {
    throw new Error(`packed archive is missing or empty: ${zipPath}`);
  }

  return { zipPath, entries, version: manifest.version };
}

function main() {
  let result;
  try {
    result = pack();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const { zipPath, entries } = result;
  const kib = (statSync(zipPath).size / 1024).toFixed(1);
  console.log(`✓ dist/ built and packed to dist/${basename(zipPath)} (${kib} KiB, ${entries.length} files)`);
  console.log(`\nInstall: extract the zip, then chrome://extensions → Developer mode → Load unpacked.`);
  console.log(`Release: tag ${result.version}, and the tag workflow attaches this archive.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
