import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildChipState } from '../extension/lib/chip.js';
import { normalize } from '../extension/lib/config.js';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

/**
 * Monotonic deadline, deliberately not `Date.now()`: this sandbox's wall clock
 * steps forward under load, which makes a wall-clock deadline expire early and
 * turns a wait into a spurious failure.
 */
async function waitFor(fn, ms = 2000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

function fakeStorage(initial) {
  let data = { ...initial };
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { data = { ...data, ...obj }; },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}

/** voz markup, trimmed to what the scraper and the chip host actually read. */
const POSTS = `
<article class="message" data-author="kido1412" data-content="post-43808330" id="js-post-43808330">
  <div class="message-cell message-cell--user">
    <section class="message-user">
      <div class="message-userDetails">
        <h4 class="message-name"><a href="/u/kido1412.821098/" class="username" data-user-id="821098">kido1412</a></h4>
      </div>
    </section>
  </div>
  <div class="message-cell message-cell--main"><div class="message-main"><div class="message-content"><div class="bbWrapper">
    Đây là một bình luận đủ dài để vượt qua ngưỡng lọc tối thiểu.
  </div></div></div></div>
</article>
`;

const labeledMember = (over = {}) => ({
  id: '821098', name: 'kido1412', totalPosts: 13,
  posts: Array.from({ length: 13 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
  threads: [], profile: {}, lastError: null,
  label: {
    choice: 'troll', probabilities: { troll: 0.62 }, lean: {}, at: Date.now(),
    evidenceCount: 13, labelSetHash: 'h',
  },
  ...over,
});

let onChanged = null;

/**
 * content.js is an IIFE that imports its helpers through `chrome.runtime.getURL`,
 * so the stub has to serve real file URLs for those imports to resolve.
 */
async function boot({ cfg = {}, members = {} } = {}) {
  document.body.innerHTML = POSTS;

  const full = normalize(cfg);
  const chips = {};
  for (const [id, rec] of Object.entries(members)) {
    chips[id] = buildChipState(rec, full, Date.now());
  }

  onChanged = null;
  globalThis.chrome = {
    runtime: {
      getURL: (p) => pathToFileURL(join(EXT, p)).href,
      sendMessage: vi.fn(async () => ({ labels: chips })),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: fakeStorage({ cfg }),
      onChanged: { addListener: (cb) => { onChanged = cb; } },
    },
  };

  // jsdom ships no matchMedia, and content.js reads it both at boot and for the
  // theme-change repaint.
  window.matchMedia = () => ({ matches: false, addEventListener() {} });

  vi.resetModules();
  await import('../extension/content.js');
  return waitFor(() => document.querySelector('.jev-chip'));
}

const chip = () => document.querySelector('.jev-chip');

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('chip rendering', () => {
  it('leads with the label icon and its name', async () => {
    expect(await boot({ members: { 821098: labeledMember() } })).toBe(true);
    expect(chip().querySelector('.jev-chip-head').textContent).toBe('👹 Troll');
  });

  it('keeps the detail line hidden, and the chip unstacked, with verbose off', async () => {
    await boot({ members: { 821098: labeledMember() } });
    expect(chip().querySelector('.jev-chip-tail').hidden).toBe(true);
    expect(chip().classList.contains('jev-chip--stacked')).toBe(false);
  });

  it('stacks the confidence, cache count and expiry below the label when verbose is on', async () => {
    await boot({ cfg: { verbose: true }, members: { 821098: labeledMember() } });

    const tail = chip().querySelector('.jev-chip-tail');
    expect(tail.hidden).toBe(false);
    expect(tail.textContent).toMatch(/^62% · 13 cmt · còn 6d$/);
    expect(chip().classList.contains('jev-chip--stacked')).toBe(true);
  });

  it('renders one chip per post, on the author line', async () => {
    await boot({ members: { 821098: labeledMember() } });
    expect(document.querySelectorAll('.jev-chip')).toHaveLength(1);
    expect(document.querySelector('.message-name .jev-chip')).not.toBeNull();
  });

  it('renders nothing for a member with no stored state', async () => {
    // Wait on the send rather than a chip: the assertion is that none appears.
    await boot({ members: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.jev-chip')).toHaveLength(0);
  });
});

describe('master toggle', () => {
  it('removes every chip when the extension is switched off', async () => {
    await boot({ cfg: { verbose: true }, members: { 821098: labeledMember() } });
    expect(chip()).not.toBeNull();

    onChanged({ cfg: { newValue: { enabled: false } } }, 'local');
    expect(document.querySelectorAll('.jev-chip')).toHaveLength(0);
  });

  it('brings them back, with the detail, when switched on again', async () => {
    await boot({ members: { 821098: labeledMember() } });
    onChanged({ cfg: { newValue: { enabled: false } } }, 'local');
    expect(document.querySelectorAll('.jev-chip')).toHaveLength(0);

    onChanged({ cfg: { newValue: { enabled: true, verbose: true } } }, 'local');
    const tail = chip().querySelector('.jev-chip-tail');
    expect(tail.hidden).toBe(false);
  });

  it('reveals the detail on an already-painted chip when verbose is switched on', async () => {
    await boot({ members: { 821098: labeledMember() } });
    expect(chip().querySelector('.jev-chip-tail').hidden).toBe(true);

    onChanged({ cfg: { newValue: { enabled: true, verbose: true } } }, 'local');
    expect(chip().querySelector('.jev-chip-tail').hidden).toBe(false);
  });

  it('ignores a change to another storage area', async () => {
    await boot({ members: { 821098: labeledMember() } });
    onChanged({ cfg: { newValue: { enabled: false } } }, 'sync');
    expect(document.querySelectorAll('.jev-chip')).toHaveLength(1);
  });
});
