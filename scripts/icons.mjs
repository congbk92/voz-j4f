#!/usr/bin/env node
/**
 * Renders extension/icons/icon.svg to the PNG sizes Chrome needs — Chrome does
 * not accept SVG for extension icons. The PNGs are committed, so this only has
 * to run when the mark itself changes.
 *
 * `@resvg/resvg-js` is deliberately NOT a dependency: it ships a large native
 * binary, and CI would install it on every run for a file that changes almost
 * never. Install it on demand for the one command that needs it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

let Resvg;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
} catch {
  console.error('✗ @resvg/resvg-js is not installed. To regenerate the icons:\n');
  console.error('    npm install --no-save @resvg/resvg-js && npm run icons\n');
  process.exit(1);
}

const svg = readFileSync(join(DIR, 'icon.svg'), 'utf8');
for (const size of SIZES) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(DIR, `icon-${size}.png`), png);
  console.log(`  icons/icon-${size}.png  ${png.length} bytes`);
}
console.log(`✓ ${SIZES.length} icons written to extension/icons/`);
