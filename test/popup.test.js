import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
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
