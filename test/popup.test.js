import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const member = (id, over = {}) => ({
  id,
  name: `u${id}`,
  totalPosts: 12,
  posts: Array.from({ length: 12 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
  seenIds: [], threads: [], profile: {}, label: null, lastError: null, lastSeenAt: 0,
  ...over,
});

const $ = (sel) => document.querySelector(sel);

/**
 * The popup is an extension page: it reads real ids out of popup.html and runs
 * `render()` on import, so the markup must be in place before the module loads.
 */
async function boot({ cfg = {}, members = [] } = {}) {
  const html = readFileSync(join(EXT, 'popup.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));

  const stored = { cfg };
  for (const m of members) stored[`m:${m.id}`] = m;
  globalThis.chrome = { storage: { local: fakeStorage(stored) } };

  vi.resetModules();
  await import('../extension/popup.js');
  await waitFor(() => $('#status').textContent !== 'Đang tải…');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('popup warning row', () => {
  it('warns that the key was rejected when a member last failed with 401', async () => {
    await boot({
      cfg: { apiKey: 'sk-test' },
      members: [member('42', { lastError: { code: 401, message: 'unauthorized', at: 5 } })],
    });
    expect($('#warn').textContent).toBe('API key sai hoặc hết hạn');
  });

  it('treats 403 the same way', async () => {
    await boot({
      cfg: { apiKey: 'sk-test' },
      members: [member('42', { lastError: { code: 403, message: 'forbidden', at: 5 } })],
    });
    expect($('#warn').textContent).toBe('API key sai hoặc hết hạn');
  });

  it('stays quiet for a failure that is not about the key', async () => {
    await boot({
      cfg: { apiKey: 'sk-test' },
      members: [member('42', { lastError: { code: 429, message: 'slow down', at: 5 } })],
    });
    expect($('#warn').textContent).toBe('');
  });

  it('stays quiet when nothing has failed', async () => {
    await boot({ cfg: { apiKey: 'sk-test' }, members: [member('42')] });
    expect($('#warn').textContent).toBe('');
  });

  it('prefers the missing-key prompt when there is no key at all', async () => {
    await boot({
      cfg: { apiKey: '' },
      members: [member('42', { lastError: { code: 401, message: 'unauthorized', at: 5 } })],
    });
    expect($('#warn').textContent).toBe('Chưa cấu hình API key — chưa thể phân loại.');
  });
});

describe('popup status line', () => {
  // `labelSetHash` is irrelevant here only because the popup never consults it;
  // the chip precedence it does consult is at/evidenceCount, handled below.
  const labeled = (at) => ({
    choice: 'troll', probabilities: null, lean: {}, at, evidenceCount: 12, labelSetHash: 'x',
  });

  it('counts a labeled member, and the row shows the same label', async () => {
    await boot({ cfg: { apiKey: 'sk-test' }, members: [member('42', { label: labeled(1000) })] });
    expect($('#status').textContent).toBe('1 thành viên · 1 đã phân loại');
    expect($('#members .row').textContent).toContain('Troll');
  });

  it('does not count a member whose error is newer than its label', async () => {
    // The divergence that shipped: `members.filter((m) => m.label)` counted this
    // member as labeled while its row rendered an error chip, so the status line
    // and the list directly below it contradicted each other.
    await boot({
      cfg: { apiKey: 'sk-test' },
      members: [member('42', {
        label: labeled(1000),
        lastError: { code: 429, message: 'slow down', at: 2000 },
      })],
    });
    expect($('#status').textContent).toBe('1 thành viên · 0 đã phân loại');
    expect($('#members .row').textContent).not.toContain('Troll');
  });

  it('still counts the label when the error is older than it', async () => {
    await boot({
      cfg: { apiKey: 'sk-test' },
      members: [member('42', {
        label: labeled(2000),
        lastError: { code: 429, message: 'slow down', at: 1000 },
      })],
    });
    expect($('#status').textContent).toBe('1 thành viên · 1 đã phân loại');
    expect($('#members .row').textContent).toContain('Troll');
  });

  it('says a member is being retried rather than leaving the row blank', async () => {
    const retrying = { attempt: 2, maxAttempts: 4, at: Date.now() };
    await boot({ cfg: { apiKey: 'sk-test' }, members: [member('42', { retrying })] });
    expect($('#members .row').textContent).toContain('đang thử lại 2/4');
    expect($('#status').textContent).toBe('1 thành viên · 0 đã phân loại');
  });
});

describe('popup detail toggle', () => {
  it('disables and greys the detail toggle while the extension is off', async () => {
    // With the master toggle off the page renders no chips at all, so the detail
    // toggle has nothing to act on and must not look settable.
    await boot({ cfg: { enabled: false, verbose: true } });
    expect($('#verbose').disabled).toBe(true);
    expect($('#verboseRow').classList.contains('off')).toBe(true);
  });

  it('leaves it usable while the extension is on', async () => {
    await boot({ cfg: { enabled: true } });
    expect($('#verbose').disabled).toBe(false);
    expect($('#verboseRow').classList.contains('off')).toBe(false);
  });
});

describe('popup member rows', () => {
  const tagged = {
    choice: 'troll', probabilities: { troll: 0.62 }, lean: {},
    at: Date.now(), evidenceCount: 12, labelSetHash: 'x',
  };

  it('shows the icon and label by default, with no percentage', async () => {
    await boot({ cfg: { apiKey: 'sk-test' }, members: [member('42', { label: tagged })] });
    const row = $('#members .row');
    expect(row.querySelector('span').textContent).toContain('👹 Troll');
    expect(row.textContent).not.toContain('62%');
  });

  it('moves the detail into the meta column when verbose, without repeating the count', async () => {
    await boot({
      cfg: { apiKey: 'sk-test', verbose: true },
      members: [member('42', { label: tagged })],
    });
    const row = $('#members .row');
    expect(row.querySelector('span').textContent).toContain('👹 Troll');
    expect(row.querySelector('.meta').textContent).toMatch(/^62% · 12 cmt · còn 6d$/);
  });

  it('still lists stored members while the extension is off', async () => {
    // Spec §9: the list renders from stored data regardless of `enabled`, so
    // switching off does not hide what the extension already knows.
    await boot({
      cfg: { enabled: false, apiKey: 'sk-test' },
      members: [member('42', { label: tagged })],
    });
    expect($('#members .row')).not.toBeNull();
  });
});
