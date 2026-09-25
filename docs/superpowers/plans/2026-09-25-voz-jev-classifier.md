# VOZ jev Member Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 extension that labels voz.vn members with a fun Vietnamese-forum archetype, using the jev evaluation model, by accumulating their comments locally as you browse.

**Architecture:** Four separable pieces. Pure logic modules under `extension/lib/` (`config`, `labels`, `voz`, `jev`, `store`, `chip`, `probe`) hold every decision that can be unit-tested. `background.js` is the only module that touches the network and the queue. `content.js` is thin DOM glue that scrapes posts and renders chips. `popup` and `options` are configuration surfaces. There is no bundler and no compile step: the source is the artifact.

**Tech Stack:** Plain ESM JavaScript, Chrome Manifest V3, `vitest` + `jsdom` for tests, Node 20+ for the build/probe/CLI scripts.

**Spec:** `docs/superpowers/specs/2026-09-25-voz-jev-classifier-design.md`

## Global Constraints

- **No bundler, no compile step.** Every file is plain ESM JavaScript. `npm run build` validates and copies; it does not transpile. Do not add TypeScript, webpack, esbuild, or babel.
- **Manifest V3**, `permissions: ["storage"]` only, `host_permissions: ["https://ai-gateway.vercel.sh/*"]`. No `tabs` permission.
- **The gateway call happens only in `background.js`.** Content scripts never fetch the gateway. MV3 grants host-permission fetches a CORS exemption; content scripts get none.
- **Content scripts are classic scripts.** No static `import` in `content.js`. Shared code is loaded with `await import(chrome.runtime.getURL('lib/x.js'))`, and `lib/*.js` is declared in `web_accessible_resources`.
- **Quoted blocks are stripped before storing, including nested ones.** A post whose stripped text is under **15 characters** is not stored at all.
- **Never cache a label whose `choice` is not a key in the criteria that were sent.** A hallucinated label is worse than no label.
- **The extension makes no requests to voz.vn** beyond what the browser already does.
- **Personal use only.** The API key lives in `chrome.storage.local`; this is never published to the Web Store.
- Label set: **16 defaults**, keys matching `[a-z0-9_]+`, at least one must always remain.
- Chip colors group by **family** (`positive`, `neutral`, `negative`, `political`), each with a light and a dark variant. Never 16 distinct hues.

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/manifest.json` | MV3 manifest; declares permissions, content script, worker, web-accessible libs |
| `extension/lib/labels.js` | The 16 default labels, family colors, the 6 lean questions, `labelSetHash` |
| `extension/lib/config.js` | Defaults, `createConfig(storage)`, `normalize` (clamping) |
| `scripts/probe.js` | `analyze(root)` — exploratory DOM structure dump. Self-contained so `.toString()` works |
| `extension/lib/voz.js` | `extractPosts(root)` — the only module that knows voz markup |
| `extension/lib/jev.js` | `buildState`, `buildQuestions`, `callJev`, `parseAnswer` — the only module that knows the gateway protocol |
| `extension/lib/store.js` | `createStore(storage)`, `shouldClassify` — accumulation, dedupe, caps, eviction |
| `extension/lib/chip.js` | `chipText`, `formatDuration` — pure chip rendering |
| `extension/background.js` | Store wiring, trigger predicate, concurrency-2 queue, gateway calls, message router |
| `extension/content.js` | DOM glue: scrape, send, render chips, MutationObserver |
| `extension/content.css` | Chip styles, light and dark |
| `extension/popup.{html,js}` | Master toggle, verbose toggle, verbose member list, clear data |
| `extension/options.{html,js}` | API key, model id, label editor, thresholds, caps, test connection |
| `scripts/build.mjs` | Validate manifest paths, copy to `dist/`, zip |
| `scripts/probe-print.mjs` | Emit a paste-ready console snippet wrapping `analyze` |
| `scripts/classify-cli.mjs` | Run a real jev round trip from Node against a JSON file |
| `test/*.test.js` | vitest suites for the pure modules |

**Deviation from the spec, noted deliberately:** the spec lists `scripts/classify-cli.ts`. This plan uses `.mjs`. The rest of the project is plain ESM JS, the repo's `ts-node` + `"type": "module"` combination is fragile for ESM TypeScript, and the CLI only wraps plain-JS `lib/` modules. TypeScript remains in the repo solely for the pre-existing scratch `index.ts`.

**Addition not named in the spec:** `extension/lib/chip.js`. The spec's §11 requires chip-text tests covering every row of the verbose table, but §4's file list gives that logic no home. It gets its own module rather than living inside `content.js`, because `content.js` is a classic script that cannot be unit-tested. `scripts/probe.js` stays outside `extension/` (as the spec has it) so it is not shipped inside the extension.

---

## Task 1: Tooling, labels, and config

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `extension/lib/labels.js`
- Create: `extension/lib/config.js`
- Test: `test/labels.test.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FAMILY_COLORS: Record<'positive'|'neutral'|'negative'|'political', { light: {bg, fg}, dark: {bg, fg} }>`
  - `DEFAULT_LABELS: Array<{ key, label, family, description }>`
  - `LEAN_QUESTIONS: Record<string, string>` (6 entries)
  - `ARCHETYPE_INSTRUCTIONS: string`
  - `labelSetHash(labels, leanQuestions): string`
  - `DEFAULTS: object`
  - `RETRY_AFTER_MS: number`
  - `normalize(cfg): object`
  - `createConfig(storage): { get(), set(patch) }`

- [ ] **Step 1: Install vitest and jsdom**

```bash
npm install -D vitest jsdom
```

- [ ] **Step 2: Add scripts and the vitest config**

Modify `package.json` — replace the `"scripts"` block:

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "node scripts/build.mjs",
    "probe": "node scripts/probe-print.mjs",
    "classify": "node scripts/classify-cli.mjs"
  },
```

Create `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
  },
});
```

- [ ] **Step 3: Write the failing labels test**

Create `test/labels.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LABELS, FAMILY_COLORS, LEAN_QUESTIONS, labelSetHash,
} from '../extension/lib/labels.js';

describe('DEFAULT_LABELS', () => {
  it('has 16 labels with unique slug keys', () => {
    expect(DEFAULT_LABELS).toHaveLength(16);
    const keys = DEFAULT_LABELS.map((l) => l.key);
    expect(new Set(keys).size).toBe(16);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+$/);
  });

  it('gives every label a family that exists in FAMILY_COLORS', () => {
    for (const l of DEFAULT_LABELS) {
      expect(FAMILY_COLORS[l.family]).toBeDefined();
    }
  });

  it('gives every label a non-empty description, since it becomes jev criteria', () => {
    for (const l of DEFAULT_LABELS) {
      expect(typeof l.description).toBe('string');
      expect(l.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('includes the merged forum-slang labels', () => {
    const keys = DEFAULT_LABELS.map((l) => l.key);
    for (const k of ['bo_do', 'ro_tau', 'ro_meo', 'ba_que', 'giao_su_mom',
                     'thanh_chui', 'troll', 'trau', 'ech_xanh', 'tu_nhuc',
                     'sinh_ngoai', 'thanh', 'nghiem_tuc', 'ca_khia', 'wumao', 'spam']) {
      expect(keys).toContain(k);
    }
  });
});

describe('LEAN_QUESTIONS', () => {
  it('has the six political axes', () => {
    expect(Object.keys(LEAN_QUESTIONS).sort()).toEqual(
      ['antiGov', 'proChina', 'proGov', 'proUS', 'selfDeprecating', 'xenophile'],
    );
  });
});

describe('labelSetHash', () => {
  it('is stable for the same input', () => {
    expect(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS))
      .toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('changes when a description changes', () => {
    const changed = DEFAULT_LABELS.map((l) =>
      l.key === 'troll' ? { ...l, description: 'something else' } : l);
    expect(labelSetHash(changed, LEAN_QUESTIONS))
      .not.toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('changes when a lean question changes', () => {
    const changed = { ...LEAN_QUESTIONS, proGov: 'different text' };
    expect(labelSetHash(DEFAULT_LABELS, changed))
      .not.toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('does not depend on label order', () => {
    const reversed = [...DEFAULT_LABELS].reverse();
    expect(labelSetHash(reversed, LEAN_QUESTIONS))
      .toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/labels.test.js`
Expected: FAIL — cannot resolve `../extension/lib/labels.js`

- [ ] **Step 5: Implement labels.js**

Create `extension/lib/labels.js`:

```js
export const FAMILY_COLORS = {
  positive:  { light: { bg: '#dcfce7', fg: '#166534' }, dark: { bg: '#14532d', fg: '#bbf7d0' } },
  neutral:   { light: { bg: '#e2e8f0', fg: '#334155' }, dark: { bg: '#334155', fg: '#e2e8f0' } },
  negative:  { light: { bg: '#fee2e2', fg: '#991b1b' }, dark: { bg: '#7f1d1d', fg: '#fecaca' } },
  political: { light: { bg: '#ede9fe', fg: '#5b21b6' }, dark: { bg: '#4c1d95', fg: '#ddd6fe' } },
};

export const DEFAULT_LABELS = [
  { key: 'thanh',       label: 'Thánh',           family: 'positive',  description: 'Kiến thức sâu, dẫn chứng cụ thể, giải đáp thắc mắc cho người khác' },
  { key: 'nghiem_tuc',  label: 'Nghiêm túc',      family: 'positive',  description: 'Thảo luận đàng hoàng, trung lập, có lý lẽ, không công kích cá nhân' },
  { key: 'ca_khia',     label: 'Cà khịa',         family: 'neutral',   description: 'Mỉa mai, chọc ngoáy, nói lái — nhưng vẫn có nội dung và quan điểm' },
  { key: 'spam',        label: 'Spam/bot',        family: 'neutral',   description: 'Quảng cáo, rao bán, lặp lại một nội dung, hoặc vô nghĩa hoàn toàn' },
  { key: 'giao_su_mom', label: 'Giáo sư mõm',     family: 'negative',  description: 'Thích lên lớp nhưng kiến thức rỗng, nói suông, không dẫn chứng' },
  { key: 'thanh_chui',  label: 'Thánh chửi',      family: 'negative',  description: 'Nổi tiếng vì chửi bới, công kích cá nhân, hạ nhục người khác' },
  { key: 'troll',       label: 'Troll',           family: 'negative',  description: 'Cố tình gây tranh cãi, chọc tức, phá thread, không đóng góp nội dung' },
  { key: 'trau',        label: 'Trẩu / Trẻ trâu', family: 'negative',  description: 'Người trẻ, nông nổi, phát ngôn thiếu chín chắn' },
  { key: 'wumao',       label: 'Wumao',           family: 'negative',  description: 'Nói sáo rỗng, a dua theo số đông, "bài viết hay quá", không có ý kiến riêng' },
  { key: 'bo_do',       label: 'Bò đỏ',           family: 'political', description: 'Bảo vệ quan điểm Đảng/Nhà nước VN' },
  { key: 'ro_tau',      label: 'Rồ tàu',          family: 'political', description: 'Thân Trung Quốc, bênh vực chính sách TQ' },
  { key: 'ro_meo',      label: 'Rồ mẽo',          family: 'political', description: 'Thân Mỹ, ca ngợi dân chủ phương Tây' },
  { key: 'ba_que',      label: '3 củ / 3que',     family: 'political', description: 'Chống cộng; gốc "cờ vàng ba sọc"' },
  { key: 'tu_nhuc',     label: 'Tự nhục',         family: 'political', description: 'Tự hạ thấp dân tộc hoặc bản thân người Việt' },
  { key: 'sinh_ngoai',  label: 'Sính ngoại',      family: 'political', description: 'Ưa chuộng nước ngoài quá mức' },
  { key: 'ech_xanh',    label: 'Ếch xanh',        family: 'political', description: 'Ngây thơ, thiếu hiểu biết chính trị' },
];

export const ARCHETYPE_INSTRUCTIONS =
  'Phân loại kiểu thành viên diễn đàn dựa trên các bình luận sau. ' +
  'Chỉ dựa vào nội dung bình luận.';

export const LEAN_QUESTIONS = {
  proGov:          'Có bảo vệ quan điểm Đảng/Nhà nước VN không?',
  proChina:        'Có thân Trung Quốc, bênh vực chính sách TQ không?',
  proUS:           'Có thân Mỹ, ca ngợi dân chủ phương Tây không?',
  antiGov:         'Có chống cộng, thái độ với chế độ hiện tại không?',
  selfDeprecating: 'Có tự hạ thấp dân tộc hoặc người Việt không?',
  xenophile:       'Có ưa chuộng nước ngoài quá mức không?',
};

/** Hash of everything that changes what jev is asked. */
export function labelSetHash(labels, leanQuestions) {
  const criteria = [...labels]
    .map((l) => `${l.key}:${l.description}`)
    .sort()
    .join('|');
  const leans = Object.entries(leanQuestions)
    .map(([k, v]) => `${k}:${v}`)
    .sort()
    .join('|');
  const input = `${criteria}##${leans}`;
  // FNV-1a, 32-bit. No node crypto: this must run in a service worker too.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
```

- [ ] **Step 6: Run the labels test to verify it passes**

Run: `npx vitest run test/labels.test.js`
Expected: PASS, 9 tests

- [ ] **Step 7: Write the failing config test**

Create `test/config.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { DEFAULTS, RETRY_AFTER_MS, normalize, createConfig } from '../extension/lib/config.js';

function fakeStorage(initial = {}) {
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
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    _dump: () => data,
  };
}

describe('DEFAULTS', () => {
  it('matches the spec', () => {
    expect(DEFAULTS).toMatchObject({
      enabled: true,
      verbose: false,
      apiKey: '',
      modelId: 'typesafe-ai/jev',
      threshold: 10,
      reclassifyEvery: 10,
      maxPostsPerMember: 20,
      maxMembers: 300,
      labelTtlMs: 604800000,
    });
    expect(DEFAULTS.labels).toHaveLength(16);
    expect(RETRY_AFTER_MS).toBe(3600000);
  });
});

describe('normalize', () => {
  it('fills in every missing key from DEFAULTS', () => {
    const cfg = normalize({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.modelId).toBe('typesafe-ai/jev');
    expect(cfg.labels).toHaveLength(16);
  });

  it('clamps threshold down to maxPostsPerMember', () => {
    const cfg = normalize({ threshold: 50, maxPostsPerMember: 20 });
    expect(cfg.threshold).toBe(20);
  });

  it('clamps threshold up to at least 1', () => {
    expect(normalize({ threshold: 0 }).threshold).toBe(1);
    expect(normalize({ threshold: -5 }).threshold).toBe(1);
  });

  it('clamps maxMembers to at least 1, since 0 would evict every stored member', () => {
    expect(normalize({ maxMembers: 0 }).maxMembers).toBe(1);
    expect(normalize({ maxMembers: -5 }).maxMembers).toBe(1);
    expect(normalize({ maxMembers: 50 }).maxMembers).toBe(50);
  });

  it('clamps reclassifyEvery to at least 1, since 0 would make every label permanently stale', () => {
    expect(normalize({ reclassifyEvery: 0 }).reclassifyEvery).toBe(1);
    expect(normalize({ reclassifyEvery: -5 }).reclassifyEvery).toBe(1);
    expect(normalize({ reclassifyEvery: 25 }).reclassifyEvery).toBe(25);
  });

  it('preserves unknown keys so a future version does not wipe them', () => {
    expect(normalize({ somethingNew: 'keep me' }).somethingNew).toBe('keep me');
  });

  it('treats labelTtlMs 0 as a real value, not missing', () => {
    expect(normalize({ labelTtlMs: 0 }).labelTtlMs).toBe(0);
  });
});

describe('createConfig', () => {
  it('returns defaults when storage is empty', async () => {
    const cfg = createConfig(fakeStorage());
    const got = await cfg.get();
    expect(got.enabled).toBe(true);
    expect(got.labels).toHaveLength(16);
  });

  it('merges a patch without dropping other keys', async () => {
    const storage = fakeStorage();
    const cfg = createConfig(storage);
    await cfg.set({ apiKey: 'sk-test' });
    await cfg.set({ verbose: true });
    const got = await cfg.get();
    expect(got.apiKey).toBe('sk-test');
    expect(got.verbose).toBe(true);
    expect(got.modelId).toBe('typesafe-ai/jev');
  });

  it('normalizes on write, so a bad threshold never reaches storage', async () => {
    const storage = fakeStorage();
    const cfg = createConfig(storage);
    await cfg.set({ threshold: 99, maxPostsPerMember: 20 });
    expect((await cfg.get()).threshold).toBe(20);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — cannot resolve `../extension/lib/config.js`

- [ ] **Step 9: Implement config.js**

Create `extension/lib/config.js`:

```js
import { DEFAULT_LABELS } from './labels.js';

export const RETRY_AFTER_MS = 3600000;

export const DEFAULTS = {
  enabled: true,
  verbose: false,
  apiKey: '',
  modelId: 'typesafe-ai/jev',
  labels: DEFAULT_LABELS,
  threshold: 10,
  reclassifyEvery: 10,
  maxPostsPerMember: 20,
  maxMembers: 300,
  labelTtlMs: 604800000,
};

const CFG_KEY = 'cfg';

export function normalize(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };

  // Number.isFinite, NOT `||`. `Number(0) || DEFAULT` short-circuits on the falsy
  // zero and silently yields the DEFAULT — so a `0` would become 300 instead of the
  // 1 these tests assert, and `Infinity` would pass through and reach
  // `posts.slice(0, Infinity)`. `isFinite` separates "explicitly 0" from "absent or
  // garbage", which is the distinction every floor below depends on.
  const n = Number(cfg.maxPostsPerMember);
  const cap = Math.max(1, Number.isFinite(n) ? n : DEFAULTS.maxPostsPerMember);
  cfg.maxPostsPerMember = cap;

  // Every count below floors at 1. A zero is not a smaller setting, it is a broken
  // one — both are reachable by typing 0 into the options page:
  //   maxMembers 0      -> eviction computes excess = all.length and drops EVERY
  //                        stored member, including the batch just written.
  //   reclassifyEvery 0 -> `totalPosts - evidenceCount < 0` is never true, so no
  //                        label is ever fresh and every collect re-classifies
  //                        every member above the threshold: unbounded gateway spend.
  // Clamped here because `normalize` is the single funnel every config read and
  // write passes through, so it binds every writer, not just the options page.
  const nMembers = Number(cfg.maxMembers);
  cfg.maxMembers = Math.max(1, Number.isFinite(nMembers) ? nMembers : DEFAULTS.maxMembers);
  const nReclassify = Number(cfg.reclassifyEvery);
  cfg.reclassifyEvery = Math.max(1, Number.isFinite(nReclassify) ? nReclassify : DEFAULTS.reclassifyEvery);

  // `threshold` keeps its `|| 1`: 0 and -5 both landing on 1 is already monotonic,
  // and an existing test pins it.
  cfg.threshold = Math.min(cap, Math.max(1, Number(cfg.threshold) || 1));
  return cfg;
}

export function createConfig(storage) {
  return {
    async get() {
      const got = await storage.get(CFG_KEY);
      return normalize(got[CFG_KEY]);
    },
    async set(patch) {
      const current = await this.get();
      const next = normalize({ ...current, ...patch });
      await storage.set({ [CFG_KEY]: next });
      return next;
    },
  };
}
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS — 9 labels tests + 13 config tests

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vitest.config.js extension/lib/labels.js extension/lib/config.js test/labels.test.js test/config.test.js
git commit -m "feat: add label set and config with tests"
```

---

## Task 2: Extension skeleton and build script

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/content.js`
- Create: `extension/content.css`
- Create: `extension/popup.html`
- Create: `extension/popup.js`
- Create: `scripts/build.mjs`
- Test: `test/build.test.js`

**Interfaces:**
- Consumes: `createConfig`, `DEFAULTS` from `lib/config.js`.
- Produces: a loadable unpacked extension in `dist/`, and `validateManifest(extDir)` from `scripts/build.mjs`.

- [ ] **Step 1: Write the failing build test**

Create `test/build.test.js`:

```js
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
    // Without it, the lib/*.js glob branch reports the glob, not the module.
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

  it('rejects invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-build-'));
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    try {
      expect(validateManifest(dir).join('\n')).toContain('not valid JSON');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/build.test.js`
Expected: FAIL — cannot resolve `../scripts/build.mjs`

- [ ] **Step 3: Implement build.mjs**

Create `scripts/build.mjs`:

```js
#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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
  const workerRel = manifest.background?.service_worker;
  if (workerRel && existsSync(join(extDir, workerRel))) {
    const src = readFileSync(join(extDir, workerRel), 'utf8');
    const re = /^import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm;
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
```

- [ ] **Step 4: Run the build test to verify it passes**

Run: `npx vitest run test/build.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the manifest**

Create `extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "VOZ jev Classifier",
  "version": "0.1.0",
  "description": "Dán nhãn thành viên voz.vn bằng model jev. Chỉ dùng cá nhân.",
  "permissions": ["storage"],
  "host_permissions": ["https://ai-gateway.vercel.sh/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://voz.vn/*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    { "resources": ["lib/*.js"], "matches": ["https://voz.vn/*"] }
  ],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html"
}
```

- [ ] **Step 6: Write the skeleton content script and styles**

Create `extension/content.js` (placeholder only — replaced in Task 9):

```js
// Skeleton. Task 9 replaces this with real scraping and chip rendering.
console.log('[jev] content script loaded on', location.pathname);
```

Create `extension/content.css`:

```css
:root {
  --jev-chip-radius: 999px;
  --jev-chip-font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.jev-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: var(--jev-chip-radius);
  font: var(--jev-chip-font);
  font-weight: 600;
  white-space: nowrap;
  vertical-align: middle;
  cursor: pointer;
}
.jev-chip--muted { opacity: 0.75; font-weight: 500; }
```

- [ ] **Step 7: Write the skeleton popup**

Create `extension/popup.html`:

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <style>
    body { width: 260px; margin: 0; padding: 12px;
           font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    #status { color: #52606d; margin: 8px 0; }
    .warn { color: #991b1b; }
  </style>
</head>
<body>
  <label><input type="checkbox" id="enabled"> Bật thu thập &amp; phân loại</label>
  <label><input type="checkbox" id="verbose"> Hiện chi tiết cache</label>
  <div id="status">Đang tải…</div>
  <div id="warn" class="warn"></div>
  <button id="options">Cài đặt</button>
  <div id="members"></div>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

Create `extension/popup.js`:

```js
import { createConfig } from './lib/config.js';

const $ = (id) => document.getElementById(id);

const cfg = createConfig(chrome.storage.local);

async function render() {
  const c = await cfg.get();
  $('enabled').checked = c.enabled;
  $('verbose').checked = c.verbose;
  $('warn').textContent = c.apiKey ? '' : 'Chưa cấu hình API key — chưa thể phân loại.';
  $('status').textContent = c.enabled ? 'Đang bật' : 'Đang tắt';
}

$('enabled').addEventListener('change', async (e) => {
  await cfg.set({ enabled: e.target.checked });
  await render();
});

$('verbose').addEventListener('change', async (e) => {
  await cfg.set({ verbose: e.target.checked });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
```

- [ ] **Step 8: Create the options placeholder so the manifest validates**

Create `extension/options.html` (full version lands in Task 11):

```html
<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><title>VOZ jev — Cài đặt</title></head>
<body>
  <h1>Cài đặt</h1>
  <p>Sẽ được hoàn thiện ở Task 11.</p>
  <script type="module" src="options.js"></script>
</body>
</html>
```

Create `extension/options.js`:

```js
import { createConfig } from './lib/config.js';
console.log('[jev] options loaded', await createConfig(chrome.storage.local).get());
```

- [ ] **Step 9: Create the background placeholder so the manifest validates**

Create `extension/background.js` (replaced in Task 8):

```js
// Skeleton. Task 8 replaces this with the store, queue, and message router.
console.log('[jev] service worker started');
```

- [ ] **Step 10: Run the build**

Run: `npm run build`
Expected: `✓ dist/ built...` then the install reminder. If it reports problems, fix the paths — this is the check working.

- [ ] **Step 11: HUMAN CHECKPOINT — load the extension**

Stop and ask the user to:
1. Open `chrome://extensions`, enable Developer mode, **Load unpacked**, select `dist/`
2. Open any voz.vn thread
3. Open the browser console and confirm `[jev] content script loaded on /t/...`
4. Open the popup and confirm both toggles render and the API-key warning shows

Do not proceed until the user confirms the extension loads and the content script runs. Everything after this depends on it.

- [ ] **Step 12: Commit**

```bash
git add extension scripts/build.mjs test/build.test.js
git commit -m "feat: extension skeleton, manifest validation, and build script"
```

---

## Task 3: Probe — discover the real voz markup

**Files:**
- Create: `scripts/probe.js`
- Create: `scripts/probe-print.mjs`
- Test: `test/probe.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `analyze(root) -> Report`. `Report` is `{ candidates: Record<string, number>, firstPost: object|null, members: object|null, pagination: object, theme: object }`. `analyze` must be **fully self-contained** — it may not reference any module-scope binding, because `probe-print.mjs` serializes it with `.toString()`.

- [ ] **Step 1: Write the failing probe test**

Create `test/probe.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { analyze } from '../scripts/probe.js';

beforeAll(() => {
  // jsdom does not implement matchMedia; the probe reports it for the theme check.
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
});

// Provisional XenForo 2.x markup. Task 3's checkpoint replaces this with real
// voz HTML captured from the browser; the assertions below should still hold.
const FIXTURE = `
<html data-variation="alternate">
<body>
  <ul class="p-breadcrumbs">
    <li><a href="/">Diễn đàn</a></li>
    <li><a href="/f/chuyen-tro-linh-tinh.17/">Chuyện trò linh tinh</a></li>
  </ul>
  <h1 class="p-title-value">Thread tiêu đề</h1>
  <article class="message message--post js-post" data-author="alice" data-content="post-111" id="js-post-111">
    <div class="message-cell message-cell--user">
      <h4 class="message-name"><a href="/members/alice.4242/" class="username">alice</a></h4>
      <div class="message-userExtras">
        <dl class="pairs"><dt>Tham gia</dt><dd>Nov 12, 2019</dd></dl>
        <dl class="pairs"><dt>Bài viết</dt><dd>4,213</dd></dl>
      </div>
    </div>
    <div class="message-cell message-cell--main">
      <div class="message-content">
        <div class="bbWrapper">Nội dung bình luận đủ dài để vượt ngưỡng mười lăm ký tự.</div>
      </div>
    </div>
  </article>
  <div class="pageNav">
    <a class="pageNav-page" href="/t/x.1/page-2">2</a>
    <a class="pageNav-page" href="/t/x.1/page-50">50</a>
  </div>
</body>
</html>`;

describe('analyze', () => {
  it('counts candidate selectors', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.candidates['article.message']).toBe(1);
    expect(report.candidates['[data-content^="post-"]']).toBe(1);
    expect(report.candidates['.bbWrapper']).toBe(1);
    expect(report.candidates['[data-author]']).toBe(1);
  });

  it('describes the first post element', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.firstPost.tag).toBe('article');
    expect(report.firstPost.attributes['data-author']).toBe('alice');
    expect(report.firstPost.attributes['data-content']).toBe('post-111');
    expect(report.firstPost.classes).toContain('message--post');
    expect(typeof report.firstPost.outerHTML).toBe('string');
    expect(report.firstPost.outerHTML.length).toBeLessThanOrEqual(1500);
  });

  it('reports member id extraction from the profile link', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.members.name).toBe('alice');
    expect(report.members.id).toBe('4242');
    expect(report.members.joined).toBe('Nov 12, 2019');
    expect(report.members.postCount).toBe('4,213');
  });

  it('reports pagination and the last page number', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.pagination.pageNavFound).toBe(true);
    expect(report.pagination.lastPage).toBe(50);
  });

  it('reports the theme mechanism', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.theme.htmlAttributes['data-variation']).toBe('alternate');
    expect(report.theme.prefersDark).toBe(false);
  });

  it('returns zero counts and nulls on a page with no posts', () => {
    const report = analyze(new DOMParser().parseFromString('<html><body></body></html>', 'text/html'));
    expect(report.candidates['article.message']).toBe(0);
    expect(report.firstPost).toBeNull();
    expect(report.members).toBeNull();
  });

  it('is self-contained, so toString() can serialize it', () => {
    // The real check: rebuild from source alone, with no module scope available.
    const rebuilt = new Function(`return (${analyze.toString()})`)();
    const report = rebuilt(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.candidates['article.message']).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/probe.test.js`
Expected: FAIL — cannot resolve `../scripts/probe.js`

- [ ] **Step 3: Implement probe.js**

Create `scripts/probe.js`. Every value it needs is declared inside the function, so `.toString()` is portable:

```js
/**
 * Exploratory DOM structure report for a voz thread page.
 *
 * Deliberately exploratory rather than confirmatory: it dumps what is there
 * rather than testing a fixed list of guesses, so it survives whatever
 * XenForo version or template customization voz is running.
 *
 * MUST stay self-contained — no module-scope references — because
 * scripts/probe-print.mjs serializes this function with .toString().
 */
export function analyze(root) {
  const CANDIDATES = [
    'article.message',
    '[data-content^="post-"]',
    '[data-author]',
    '.message',
    '.bbWrapper',
    '.message-content',
    '.message-userExtras',
    '.message-name',
    '.message-attribution',
    'li.message',
    'table[id^="post"]',
    '.pageNav',
    '.p-title-value',
    '.p-breadcrumbs',
  ];

  const candidates = {};
  for (const sel of CANDIDATES) {
    let n = 0;
    try { n = root.querySelectorAll(sel).length; } catch { n = -1; }
    candidates[sel] = n;
  }

  const first = root.querySelector('article.message')
    || root.querySelector('[data-content^="post-"]')
    || root.querySelector('li.message')
    || root.querySelector('table[id^="post"]')
    || null;

  let firstPost = null;
  if (first) {
    const attributes = {};
    for (const a of first.attributes) attributes[a.name] = a.value;
    firstPost = {
      tag: first.tagName.toLowerCase(),
      classes: [...first.classList],
      attributes,
      outerHTML: first.outerHTML.slice(0, 1500),
    };
  }

  let members = null;
  if (first) {
    const link = first.querySelector('.message-name a[href*="/members/"], a.username[href*="/members/"]');
    const href = link ? link.getAttribute('href') : null;
    const m = href ? href.match(/\.(\d+)\/?$/) : null;
    // Collapse whitespace first: <dt>/<dd> markup concatenates without spaces.
    const extrasText = (first.querySelector('.message-userExtras')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const joined = extrasText.match(/(?:Tham gia|Joined)\s*:?\s*(.+?)(?=\s*(?:Bài viết|Messages|Trophy|Điểm|$))/i);
    const postCount = extrasText.match(/(?:Bài viết|Messages)\s*:?\s*([\d.,]+)/i);
    members = {
      name: link ? link.textContent.trim() : (first.getAttribute('data-author') || null),
      id: m ? m[1] : null,
      joined: joined ? joined[1].trim() : null,
      postCount: postCount ? postCount[1].trim() : null,
      extrasSample: extrasText.slice(0, 300),
      href,
    };
  }

  const pageLinks = [...root.querySelectorAll('.pageNav-page, .pageNav a')];
  let lastPage = null;
  for (const a of pageLinks) {
    const n = parseInt(a.textContent.trim(), 10);
    if (!Number.isNaN(n) && (lastPage === null || n > lastPage)) lastPage = n;
  }
  const pagination = {
    pageNavFound: root.querySelectorAll('.pageNav').length > 0,
    linkCount: pageLinks.length,
    lastPage,
    sample: pageLinks.slice(0, 6).map((a) => a.getAttribute('href')),
  };

  const html = root.documentElement || root.querySelector('html');
  const htmlAttributes = {};
  if (html) for (const a of html.attributes) htmlAttributes[a.name] = a.value;
  const theme = {
    htmlAttributes,
    htmlClasses: html ? [...html.classList] : [],
    bodyClasses: root.body ? [...root.body.classList] : [],
    prefersDark: typeof matchMedia === 'function'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : null,
  };

  return { candidates, firstPost, members, pagination, theme };
}
```

- [ ] **Step 4: Run the probe test to verify it passes**

Run: `npx vitest run test/probe.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Implement the snippet printer**

Create `scripts/probe-print.mjs`:

```js
#!/usr/bin/env node
import { analyze } from '../scripts/probe.js';

const snippet = `(() => {
  const analyze = ${analyze.toString()};
  const report = analyze(document);
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === 'function') { copy(json); console.log('\\n✅ JSON copied to clipboard'); }
  else console.log('\\nℹ️ Select the JSON above and copy it manually.');
})();`;

console.log(snippet);
console.error('\n---\nCopy everything above, paste it into the DevTools console on a voz thread page,');
console.error('then paste the JSON it prints back into the conversation.\n');
```

- [ ] **Step 6: Verify the printer emits a runnable snippet**

Run: `npm run probe | head -20`
Expected: a `(() => { const analyze = function analyze(root) { ...` snippet on stdout, instructions on stderr.

- [ ] **Step 7: HUMAN CHECKPOINT — capture the real markup**

Stop and ask the user to:
1. Run `npm run probe`
2. Copy the printed snippet
3. Open a voz.vn thread page in a logged-in browser
4. Paste the snippet into the DevTools console and run it
5. Paste the resulting JSON back

The JSON determines `SELECTORS` in Task 4 and `THEME` detection in Task 9, and the printed markup becomes the Task 4 test fixture. **Do not proceed to Task 4 without it.** If the user cannot run it, ask them to save the thread page's HTML and share that instead.

- [ ] **Step 8: Commit**

```bash
git add scripts/probe.js scripts/probe-print.mjs test/probe.test.js
git commit -m "feat: add exploratory DOM probe for voz markup discovery"
```

---

## Task 4: voz extraction

**Files:**
- Create: `extension/lib/voz.js`
- Test: `test/voz.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractPosts(root) -> IncomingPost[]`, where
  `IncomingPost = { postId: string, memberId: string, name: string, text: string, thread: string|null, joined: string|null, postCount: string|null }`
  Also exports `SELECTORS`, `MIN_POST_CHARS = 15`, `cleanText(text)`, `postTextFrom(el)`,
  `postIdOf(el) -> string|null`, `memberIdOf(el) -> string|null`.
  The last two exist so `content.js` does not re-derive the same id regexes.

- [ ] **Step 1: Write the failing extraction test**

Create `test/voz.test.js`. **Step 1a:** paste the real `outerHTML` the Task 3 checkpoint returned into `FIXTURE_POST` and the surrounding page structure into `FIXTURE_PAGE`. The markup below is the provisional XenForo 2.x shape and is what the assertions are written against — if the checkpoint shows different structure, adjust `SELECTORS` in Step 3 rather than the assertions' intent.

```js
import { describe, it, expect } from 'vitest';
import { extractPosts, MIN_POST_CHARS } from '../extension/lib/voz.js';

const FIXTURE_PAGE = `
<html><body>
  <h1 class="p-title-value">Thread tiêu đề</h1>

  <article class="message message--post js-post" data-author="alice" data-content="post-111" id="js-post-111">
    <div class="message-cell message-cell--user">
      <h4 class="message-name"><a href="/members/alice.4242/" class="username">alice</a></h4>
      <div class="message-userExtras">
        <dl class="pairs"><dt>Tham gia</dt><dd>Nov 12, 2019</dd></dl>
        <dl class="pairs"><dt>Bài viết</dt><dd>4,213</dd></dl>
      </div>
    </div>
    <div class="message-cell message-cell--main">
      <div class="message-content"><div class="bbWrapper">
        Đây là một bình luận đủ dài để vượt qua ngưỡng lọc tối thiểu.
        <blockquote class="bbCodeBlock bbCodeBlock--quote">
          <div class="bbCodeBlock-content">Nguyên văn lời của người khác mà ta không được tính.</div>
        </blockquote>
        Phần nội dung tiếp theo của chính alice.
      </div></div>
    </div>
  </article>

  <article class="message message--post js-post" data-author="bob" data-content="post-222" id="js-post-222">
    <div class="message-cell message-cell--user">
      <h4 class="message-name"><a href="/members/bob.555/" class="username">bob</a></h4>
    </div>
    <div class="message-cell message-cell--main">
      <div class="message-content"><div class="bbWrapper">
        <blockquote class="bbCodeBlock bbCodeBlock--quote">
          <div class="bbCodeBlock-content">Chỉ toàn là trích dẫn, không có chữ nào của bob ở đây cả.</div>
        </blockquote>
      </div></div>
    </div>
  </article>

  <article class="message message--post js-post" data-author="carol" data-content="post-333" id="js-post-333">
    <div class="message-cell message-cell--user">
      <h4 class="message-name"><a href="/members/carol.777/" class="username">carol</a></h4>
    </div>
    <div class="message-cell message-cell--main">
      <div class="message-content"><div class="bbWrapper">
        Ngắn
        <blockquote class="bbCodeBlock bbCodeBlock--quote">
          <div class="bbCodeBlock-content">Trích dẫn dài dòng mà carol không hề viết ra.</div>
        </blockquote>
      </div></div>
    </div>
  </article>

  <article class="message message--post js-post" data-author="dave" data-content="post-444" id="js-post-444">
    <div class="message-cell message-cell--user">
      <h4 class="message-name"><a href="/members/dave.888/" class="username">dave</a></h4>
    </div>
    <div class="message-cell message-cell--main">
      <div class="message-content"><div class="bbWrapper">
        Mở đầu bài của dave cũng đủ dài để được giữ lại.
        <blockquote class="bbCodeBlock bbCodeBlock--quote">
          <div class="bbCodeBlock-content">
            Trích dẫn lồng nhau của người khác.
            <blockquote class="bbCodeBlock bbCodeBlock--quote">
              <div class="bbCodeBlock-content">Sâu hơn nữa, cũng không phải của dave.</div>
            </blockquote>
          </div>
        </blockquote>
        Kết thúc bài của dave ở đây.
      </div></div>
    </div>
  </article>
</body></html>`;

const doc = () => new DOMParser().parseFromString(FIXTURE_PAGE, 'text/html');

describe('extractPosts', () => {
  it('returns one entry per post with usable text, dropping the rest', () => {
    // bob is pure quote, carol is under the floor, so only alice and dave remain.
    expect(extractPosts(doc()).map((p) => p.postId)).toEqual(['111', '444']);
  });

  it('pulls member id from the profile link and name from data-author', () => {
    const alice = extractPosts(doc()).find((p) => p.postId === '111');
    expect(alice.memberId).toBe('4242');
    expect(alice.name).toBe('alice');
  });

  it('strips a quoted block from the middle of a post, keeping both own parts', () => {
    const alice = extractPosts(doc()).find((p) => p.postId === '111');
    expect(alice.text).not.toContain('Nguyên văn lời của người khác');
    expect(alice.text).toContain('Đây là một bình luận đủ dài');
    expect(alice.text).toContain('Phần nội dung tiếp theo của chính alice');
  });

  it('strips nested quoted blocks', () => {
    const dave = extractPosts(doc()).find((p) => p.postId === '444');
    expect(dave.text).not.toContain('Trích dẫn lồng nhau');
    expect(dave.text).not.toContain('Sâu hơn nữa');
    expect(dave.text).toContain('Mở đầu bài của dave');
    expect(dave.text).toContain('Kết thúc bài của dave');
  });

  it('drops a post that is nothing but a quote', () => {
    expect(extractPosts(doc()).find((p) => p.postId === '222')).toBeUndefined();
  });

  it('drops a post whose stripped text is under the floor', () => {
    // carol's own words are 'Ngắn' — 4 characters; the rest was someone else's.
    expect(extractPosts(doc()).find((p) => p.postId === '333')).toBeUndefined();
    expect(MIN_POST_CHARS).toBe(15);
  });

  it('collapses whitespace', () => {
    const alice = extractPosts(doc()).find((p) => p.postId === '111');
    expect(alice.text).not.toMatch(/\s{2,}/);
    expect(alice.text).not.toMatch(/^\s|\s$/);
  });

  it('carries thread title when present', () => {
    const alice = extractPosts(doc()).find((p) => p.postId === '111');
    expect(alice.thread).toBe('Thread tiêu đề');
  });

  it('carries join date and post count when present, null when absent', () => {
    const posts = extractPosts(doc());
    const alice = posts.find((p) => p.postId === '111');
    const dave = posts.find((p) => p.postId === '444');
    expect(alice.joined).toBe('Nov 12, 2019');
    expect(alice.postCount).toBe('4,213');
    expect(dave.joined).toBeNull();
    expect(dave.postCount).toBeNull();
  });

  it('returns an empty array on a page with no posts', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(extractPosts(empty)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/voz.test.js`
Expected: FAIL — cannot resolve `../extension/lib/voz.js`

- [ ] **Step 3: Implement voz.js**

Create `extension/lib/voz.js`. **This is the only file that knows voz's markup.** If the Task 3 checkpoint reported different structure, change `SELECTORS` here and re-run the tests.

```js
/** The only module that knows voz.vn markup. Verified against the Task 3 probe. */
export const SELECTORS = {
  post: 'article.message, [data-content^="post-"]',
  content: '.bbWrapper',
  quote: 'blockquote',
  memberLink: '.message-name a[href*="/members/"], a.username[href*="/members/"]',
  extras: '.message-userExtras',
  threadTitle: '.p-title-value, h1.p-title-value',
};

/** A post shorter than this after quote-stripping is not evidence of anything. */
export const MIN_POST_CHARS = 15;

/** Collapse runs of whitespace and trim. */
export function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Post body text with every nested quote removed. */
export function postTextFrom(el) {
  const content = el.querySelector(SELECTORS.content) || el;
  const clone = content.cloneNode(true);
  for (const q of clone.querySelectorAll(SELECTORS.quote)) q.remove();
  return cleanText(clone.textContent);
}

/** Exported so content.js reuses it rather than re-deriving the same regex. */
export function memberIdOf(el) {
  const link = el.querySelector(SELECTORS.memberLink);
  const href = link && link.getAttribute('href');
  const m = href && href.match(/\.(\d+)\/?$/);
  return m ? m[1] : null;
}

function profileFrom(el) {
  const extras = el.querySelector(SELECTORS.extras);
  const text = extras ? cleanText(extras.textContent) : '';
  const joined = text.match(/(?:Tham gia|Joined)\s*:?\s*([^\s]+(?:\s+[^\s]+){0,2}?)(?=\s*(?:Bài viết|Messages|Trophy|Điểm|$))/i);
  const postCount = text.match(/(?:Bài viết|Messages)\s*:?\s*([\d.,]+)/i);
  return {
    joined: joined ? joined[1].trim() : null,
    postCount: postCount ? postCount[1].trim() : null,
  };
}

export function postIdOf(el) {
  const content = el.getAttribute('data-content');
  if (content) {
    const m = content.match(/post-(\d+)/);
    if (m) return m[1];
  }
  const id = el.getAttribute('id');
  if (id) {
    const m = id.match(/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/** Extract every usable post on a page (or a parsed document). */
export function extractPosts(root) {
  const titleEl = root.querySelector(SELECTORS.threadTitle);
  const thread = titleEl ? cleanText(titleEl.textContent) : null;
  const out = [];

  for (const el of root.querySelectorAll(SELECTORS.post)) {
    const postId = postIdOf(el);
    const memberId = memberIdOf(el);
    if (!postId || !memberId) continue;

    const text = postTextFrom(el);
    if (text.length < MIN_POST_CHARS) continue;

    const profile = profileFrom(el);
    out.push({
      postId,
      memberId,
      name: el.getAttribute('data-author') || (el.querySelector(SELECTORS.memberLink)?.textContent || '').trim(),
      text,
      thread,
      joined: profile.joined,
      postCount: profile.postCount,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the extraction test**

Run: `npx vitest run test/voz.test.js`
Expected: PASS, 10 tests

If the count differs from the fixture's intent, fix `SELECTORS` — not the assertions. The assertions encode the spec's rules (quote-stripping, the 15-char floor, whitespace) and must stay.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/voz.js test/voz.test.js
git commit -m "feat: extract voz posts with quote stripping and length floor"
```

---

## Task 5: jev gateway client

**Files:**
- Create: `extension/lib/jev.js`
- Test: `test/jev.test.js`

**Interfaces:**
- Consumes: `FAMILY_COLORS` from `lib/labels.js`; `ARCHETYPE_INSTRUCTIONS`, `LEAN_QUESTIONS` passed in by the caller.
- Produces:
  - `MAX_POSTS = 6`, `MAX_POST_CHARS = 800`
  - `buildState(member) -> object`
  - `buildQuestions(labels, leanQuestions, archetypeInstructions) -> object`
  - `GATEWAY_ENDPOINT`
  - `callJev({ apiKey, modelId, state, questions, fetchImpl?, endpoint? }) -> Promise<answers>`
  - `parseAnswer(answers, labels) -> { choice, probabilities, lean }` — throws `JevAnswerError`
  - `JevHttpError`, `JevAnswerError`

- [ ] **Step 1: Write the failing jev test**

Create `test/jev.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import {
  buildState, buildQuestions, callJev, parseAnswer,
  GATEWAY_ENDPOINT, MAX_POSTS, MAX_POST_CHARS,
  JevHttpError, JevAnswerError,
} from '../extension/lib/jev.js';
import { DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS } from '../extension/lib/labels.js';

const member = (posts, extra = {}) => ({
  id: '1', name: 'alice', totalPosts: posts.length,
  posts: posts.map((t, i) => ({ postId: String(i), text: t, ts: 0 })),
  threads: ['Thread A'], profile: { joined: '2019', postCount: '4213' },
  ...extra,
});

describe('buildState', () => {
  it('takes the 6 longest posts, ranked before truncation', () => {
    const posts = ['a'.repeat(10), 'b'.repeat(900), 'c'.repeat(3000), 'd'.repeat(50),
                   'e'.repeat(1200), 'f'.repeat(800), 'g'.repeat(700)];
    const state = buildState(member(posts));
    expect(state.posts).toHaveLength(MAX_POSTS);
    // Identity is the only way to observe rank-before-truncate: c, e, b and f all
    // cap at 800, so truncate-then-rank would yield b,c,e,f,g,d instead.
    expect(state.posts.map((p) => p[0])).toEqual(['c', 'e', 'b', 'f', 'g', 'd']);
    expect(state.posts[0]).toHaveLength(MAX_POST_CHARS);
    expect(state.posts[1]).toHaveLength(MAX_POST_CHARS);  // 1200-char post, truncated
    expect(state.posts[4]).toHaveLength(700);             // under the cap, survives whole
    expect(state.posts[5]).toHaveLength(50);
  });

  it('truncates each post at 800 characters', () => {
    const state = buildState(member(['x'.repeat(5000)]));
    expect(state.posts[0]).toHaveLength(MAX_POST_CHARS);
  });

  it('includes member context when observed', () => {
    const state = buildState(member(['nội dung đủ dài để dùng được ở đây']));
    expect(state.member).toBe('alice');
    expect(state.joined).toBe('2019');
    expect(state.postCount).toBe('4213');
    expect(state.threads).toEqual(['Thread A']);
  });

  it('omits context keys that were never observed', () => {
    const m = member(['nội dung đủ dài để dùng được ở đây'], {
      profile: {}, threads: [],
    });
    const state = buildState(m);
    expect('joined' in state).toBe(false);
    expect('postCount' in state).toBe(false);
    expect('threads' in state).toBe(false);
  });

  it('caps threads at 5', () => {
    const m = member(['nội dung đủ dài để dùng được ở đây'], {
      threads: ['1', '2', '3', '4', '5', '6', '7'],
    });
    expect(buildState(m).threads).toHaveLength(5);
  });
});

describe('buildQuestions', () => {
  it('mirrors the label set into choice criteria', () => {
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    expect(q.archetype.type).toBe('choice');
    expect(q.archetype.instructions).toBe(ARCHETYPE_INSTRUCTIONS);
    expect(Object.keys(q.archetype.criteria)).toHaveLength(16);
    expect(q.archetype.criteria.troll).toContain('gây tranh cãi');
  });

  it('builds one boolean per lean question, flat beside archetype', () => {
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    expect(Object.keys(q)).toHaveLength(1 + Object.keys(LEAN_QUESTIONS).length);
    for (const key of Object.keys(LEAN_QUESTIONS)) {
      expect(q[key].type).toBe('boolean');
      expect(typeof q[key].instructions).toBe('string');
    }
  });

  it('gives every question its own type discriminator, which is what the gateway validates', () => {
    // The nesting bug shipped past the suite because nothing asserted this: every
    // value in `questions` must carry a `type`, and the gateway 400s without it.
    const q = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);
    for (const v of Object.values(q)) {
      expect(['choice', 'score', 'boolean']).toContain(v.type);
      expect(typeof v.instructions).toBe('string');
    }
  });
});

describe('callJev', () => {
  const ok = (body) => vi.fn(async () => ({
    ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  }));

  it('posts to the gateway with the spec headers and body', async () => {
    const fetchImpl = ok({ answers: { archetype: { type: 'choice', choice: 'troll' } } });
    await callJev({
      apiKey: 'sk-abc', modelId: 'typesafe-ai/jev',
      state: { member: 'alice' }, questions: { archetype: {} }, fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GATEWAY_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-abc');
    expect(init.headers['ai-evaluation-model-specification-version']).toBe('4');
    expect(init.headers['ai-gateway-protocol-version']).toBe('0.0.1');
    expect(init.headers['ai-gateway-auth-method']).toBe('api-key');
    expect(init.headers['ai-model-id']).toBe('typesafe-ai/jev');
    expect(JSON.parse(init.body)).toEqual({
      state: { member: 'alice' }, questions: { archetype: {} }, providerOptions: {},
    });
  });

  it('returns the answers map', async () => {
    const fetchImpl = ok({ answers: { archetype: { type: 'choice', choice: 'troll' } } });
    const answers = await callJev({ apiKey: 'k', modelId: 'm', state: {}, questions: {}, fetchImpl });
    expect(answers.archetype.choice).toBe('troll');
  });

  it('throws JevHttpError carrying the status on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}),
    }));
    await expect(callJev({ apiKey: 'bad', modelId: 'm', state: {}, questions: {}, fetchImpl }))
      .rejects.toBeInstanceOf(JevHttpError);
    try {
      await callJev({ apiKey: 'bad', modelId: 'm', state: {}, questions: {}, fetchImpl });
    } catch (e) {
      expect(e.status).toBe(401);
      expect(e.message).toContain('unauthorized');
    }
  });
});

describe('parseAnswer', () => {
  // `questions` is flat, so lean answers sit beside archetype at the top level
  // rather than nested under a `lean` key. Spreading mirrors that shape.
  const answers = (archetype, lean = {}) => ({ archetype, ...lean });

  it('accepts a valid choice and keeps probabilities', () => {
    const got = parseAnswer(answers(
      { type: 'choice', choice: 'troll', probabilities: { troll: 0.62, thanh: 0.38 } },
    ), DEFAULT_LABELS);
    expect(got.choice).toBe('troll');
    expect(got.probabilities).toEqual({ troll: 0.62, thanh: 0.38 });
  });

  it('tolerates missing probabilities', () => {
    const got = parseAnswer(answers({ type: 'choice', choice: 'troll' }), DEFAULT_LABELS);
    expect(got.probabilities).toBeNull();
  });

  it('throws on a choice that is not in the label set', () => {
    expect(() => parseAnswer(answers({ type: 'choice', choice: 'khong_ton_tai' }), DEFAULT_LABELS))
      .toThrow(JevAnswerError);
  });

  it('throws when the archetype answer is missing entirely', () => {
    expect(() => parseAnswer({ lean: {} }, DEFAULT_LABELS)).toThrow(JevAnswerError);
  });

  it('collects every valid lean probability', () => {
    const got = parseAnswer(answers(
      { type: 'choice', choice: 'bo_do' },
      { proGov: { type: 'boolean', probability: 0.81 }, proChina: { type: 'boolean', probability: 0.44 } },
    ), DEFAULT_LABELS);
    expect(got.lean).toEqual({ proGov: 0.81, proChina: 0.44 });
  });

  it('drops a malformed lean without discarding the archetype', () => {
    const got = parseAnswer(answers(
      { type: 'choice', choice: 'bo_do' },
      {
        proGov: { type: 'boolean', probability: 0.81 },
        proChina: { type: 'boolean', probability: 3 },
        proUS: { type: 'score', score: 1 },
        antiGov: null,
      },
    ), DEFAULT_LABELS);
    expect(got.choice).toBe('bo_do');
    expect(got.lean).toEqual({ proGov: 0.81 });
  });

  it('returns an empty lean map when lean is absent', () => {
    const got = parseAnswer(answers({ type: 'choice', choice: 'troll' }), DEFAULT_LABELS);
    expect(got.lean).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/jev.test.js`
Expected: FAIL — cannot resolve `../extension/lib/jev.js`

- [ ] **Step 3: Implement jev.js**

Create `extension/lib/jev.js`:

```js
export const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const MAX_POSTS = 6;
export const MAX_POST_CHARS = 800;
const MAX_THREADS = 5;

export class JevHttpError extends Error {
  constructor(status, body) {
    super(`Gateway returned ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'JevHttpError';
    this.status = status;
    this.body = body;
  }
}

export class JevAnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JevAnswerError';
  }
}

/** At most 6 posts, ranked by original length, then truncated. */
export function buildState(member) {
  const posts = [...(member.posts || [])]
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_POSTS)
    .map((p) => p.text.slice(0, MAX_POST_CHARS));

  const state = { member: member.name, posts };
  if (member.threads && member.threads.length) state.threads = member.threads.slice(0, MAX_THREADS);
  if (member.profile && member.profile.joined) state.joined = member.profile.joined;
  if (member.profile && member.profile.postCount != null) state.postCount = member.profile.postCount;
  return state;
}

export function buildQuestions(labels, leanQuestions, archetypeInstructions) {
  const criteria = {};
  for (const l of labels) criteria[l.key] = l.description;

  // FLAT, not nested. `questions` is a map of question id -> question, and each
  // value must carry its own `type` discriminator. Nesting the lean booleans under
  // a `lean` key makes the gateway read `questions.lean` as a question with no
  // `type` and answer 400 "Invalid discriminator value … path: questions.lean.type".
  const questions = {
    archetype: { type: 'choice', instructions: archetypeInstructions, criteria },
  };
  for (const [key, instructions] of Object.entries(leanQuestions)) {
    questions[key] = { type: 'boolean', instructions };
  }
  return questions;
}

export async function callJev({ apiKey, modelId, state, questions, fetchImpl = fetch, endpoint = GATEWAY_ENDPOINT }) {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Captured from the installed SDK's fetch, not read from its source. The
      // provider factory adds the protocol and auth-method headers; the
      // evaluation-model class does not, and omitting them earns a
      // `400 Unsupported gateway protocol version` rather than a missing-header
      // error, which is slow to diagnose from the message alone.
      'ai-evaluation-model-specification-version': '4',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': 'api-key',
      'ai-model-id': modelId,
    },
    body: JSON.stringify({ state, questions, providerOptions: {} }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new JevHttpError(res.status, body);
  }

  const json = await res.json();
  return json.answers || {};
}

/** Validate a raw answers map. Throws rather than caching an invented label. */
export function parseAnswer(answers, labels) {
  const a = answers && answers.archetype;
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') {
    throw new JevAnswerError('missing archetype choice answer');
  }
  if (!labels.some((l) => l.key === a.choice)) {
    throw new JevAnswerError(`choice not in label set: ${a.choice}`);
  }

  // The lean answers sit beside `archetype` at the top level, because `questions`
  // is flat. Every non-archetype question we send is a boolean lean axis, so
  // anything that parses as one is collected.
  const lean = {};
  for (const [key, v] of Object.entries(answers || {})) {
    if (key === 'archetype') continue;
    if (v && v.type === 'boolean'
        && typeof v.probability === 'number'
        && v.probability >= 0 && v.probability <= 1) {
      lean[key] = v.probability;
    }
  }

  return {
    choice: a.choice,
    probabilities: a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null,
    lean,
  };
}
```

- [ ] **Step 4: Run the jev test**

Run: `npx vitest run test/jev.test.js`
Expected: PASS, 18 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all suites

- [ ] **Step 6: Commit**

```bash
git add extension/lib/jev.js test/jev.test.js
git commit -m "feat: jev gateway client, state and question builders"
```

---

## Task 6: Classify CLI — first real jev round trip

**Files:**
- Create: `scripts/classify-cli.mjs`
- Create: `example-member.json`

**Interfaces:**
- Consumes: `buildState`, `buildQuestions`, `callJev`, `parseAnswer` from `lib/jev.js`; `DEFAULT_LABELS`, `LEAN_QUESTIONS`, `ARCHETYPE_INSTRUCTIONS` from `lib/labels.js`.
- Produces: nothing importable. A workstation tool.

- [ ] **Step 1: Create a sample member file**

Create `example-member.json`:

```json
{
  "id": "4242",
  "name": "example",
  "totalPosts": 4,
  "threads": ["[Nóng] Tranh luận về giá điện"],
  "profile": { "joined": "Nov 12, 2019", "postCount": "4,213" },
  "posts": [
    { "postId": "1", "ts": 0, "text": "Theo tôi thì vấn đề này cần nhìn vào số liệu cụ thể. Năm 2023 EVN báo lỗ 26.000 tỷ, nhưng nếu tách riêng chi phí phân phối thì con số khác hẳn. Bác nào có nguồn thì dẫn ra cùng bàn." },
    { "postId": "2", "ts": 0, "text": "Nói mãi cũng chỉ có mấy câu đó, chả có dẫn chứng gì cả. Chán." },
    { "postId": "3", "ts": 0, "text": "Việt Nam mình thua xa người ta, ra nước ngoài mà xem họ làm ăn thế nào rồi hãy nói." },
    { "postId": "4", "ts": 0, "text": "Cái này tôi nghĩ nên đợi cơ quan chức năng công bố đã, mọi người suy đoán nhiều quá." }
  ]
}
```

- [ ] **Step 2: Implement the CLI**

Create `scripts/classify-cli.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildState, buildQuestions, callJev, parseAnswer } from '../extension/lib/jev.js';
import { DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS } from '../extension/lib/labels.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(ROOT, '.env.local') });

const file = process.argv[2] || resolve(ROOT, 'example-member.json');
const apiKey = process.env.AI_GATEWAY_API_KEY;
const modelId = process.argv[3] || 'typesafe-ai/jev';

if (!apiKey) {
  console.error('✗ AI_GATEWAY_API_KEY is not set. Put it in .env.local');
  process.exit(1);
}

const member = JSON.parse(readFileSync(file, 'utf8'));
const state = buildState(member);
const questions = buildQuestions(DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);

console.log(`→ ${member.name} · ${state.posts.length} posts · ${state.posts.reduce((n, p) => n + p.length, 0)} chars\n`);

const answers = await callJev({ apiKey, modelId, state, questions });
const parsed = parseAnswer(answers, DEFAULT_LABELS);   // throws on an invented choice

const label = DEFAULT_LABELS.find((l) => l.key === parsed.choice);
console.log(`  ${label.label}  (${label.key})`);
if (parsed.probabilities) {
  const top = Object.entries(parsed.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [k, p] of top) console.log(`    ${(p * 100).toFixed(0).padStart(3)}%  ${k}`);
}
if (Object.keys(parsed.lean).length) {
  console.log('\n  lean:');
  for (const [k, p] of Object.entries(parsed.lean)) {
    console.log(`    ${(p * 100).toFixed(0).padStart(3)}%  ${k}`);
  }
}
console.log(`\n  raw answers: ${JSON.stringify(answers).slice(0, 400)}`);
```

- [ ] **Step 3: HUMAN CHECKPOINT — run it against the real gateway**

Run: `npm run classify`

Expected: a label with a probability distribution, or an honest error. Three outcomes, all informative:

- **A label prints.** jev works, the protocol is right, and the prompt is usable. Note in the conversation whether the label looks sane for the sample text.
- **`JevHttpError` 401/403.** The key is wrong or lacks evaluation-model access. Ask the user to check `AI_GATEWAY_API_KEY` in `.env.local`.
- **`JevHttpError` 404 or 400.** The endpoint or headers are wrong. Re-read `node_modules/@ai-sdk/gateway/dist/index.js` around `GatewayEvaluationModel` and correct `GATEWAY_ENDPOINT`/headers in `lib/jev.js`.

Do not proceed until this prints a label. Every later task depends on the protocol being right, and this is the cheapest place to find out it is not.

- [ ] **Step 4: Iterate on prompts here, not in the extension**

This step has no completion criterion beyond judgement. If labels look wrong on the sample — e.g. everything comes back `nghiem_tuc` — adjust `ARCHETYPE_INSTRUCTIONS` or label descriptions in `lib/labels.js` and re-run. This is the whole reason the CLI exists: the loop is a second, versus a rebuild-and-reload cycle.

Record in the conversation any label-description change you make, because it changes `labelSetHash` and invalidates stored labels.

- [ ] **Step 5: Commit**

```bash
git add scripts/classify-cli.mjs example-member.json extension/lib/labels.js
git commit -m "feat: classify CLI for iterating on jev prompts outside the extension"
```

---

## Task 7: Store — accumulation, dedupe, caps, trigger

**Files:**
- Create: `extension/lib/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `normalize`, `RETRY_AFTER_MS` from `lib/config.js`.
- Produces:
  - `MEMBER_PREFIX = 'm:'`
  - `createStore(storage, now?)` with `{ upsertPosts(posts, cfg), getMember(id), getMembers(ids), listMembers(), setLabel(id, label), setError(id, err), clear(), count() }`
  - `shouldClassify({ member, cfg, now, hash, force }) -> boolean` (pure, exported separately for direct testing)

- [ ] **Step 1: Write the failing store test**

Create `test/store.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { createStore, shouldClassify, MEMBER_PREFIX } from '../extension/lib/store.js';
import { normalize, RETRY_AFTER_MS } from '../extension/lib/config.js';
import { DEFAULT_LABELS, LEAN_QUESTIONS, labelSetHash } from '../extension/lib/labels.js';

const HASH = labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS);
const CFG = normalize({ apiKey: 'sk-test' });

function fakeStorage() {
  let data = {};
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

const post = (postId, memberId, text, extra = {}) => ({
  postId, memberId, name: `u${memberId}`, text, thread: 'T', joined: null, postCount: null, ...extra,
});

let now;
let store;
beforeEach(() => {
  now = 1_000_000_000_000;
  store = createStore(fakeStorage(), () => now);
});

describe('upsertPosts', () => {
  it('creates a member and stores the post', async () => {
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    const m = await store.getMember('42');
    expect(m.id).toBe('42');
    expect(m.totalPosts).toBe(1);
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0].postId).toBe('1');
  });

  it('dedupes by postId so re-reading a page does not inflate the count', async () => {
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    await store.upsertPosts([post('1', '42', 'nội dung đủ dài cho một bình luận')]);
    const m = await store.getMember('42');
    expect(m.totalPosts).toBe(1);
    expect(m.posts).toHaveLength(1);
  });

  it('keeps newest first and caps stored posts, leaving totalPosts monotonic', async () => {
    const cfg = { maxPostsPerMember: 20 };
    for (let i = 1; i <= 25; i++) {
      await store.upsertPosts([post(String(i), '42', `bình luận số ${i} đủ dài để lưu`)], cfg);
    }
    const m = await store.getMember('42');
    expect(m.posts).toHaveLength(20);
    expect(m.totalPosts).toBe(25);
    expect(m.posts[0].postId).toBe('25');   // newest first
    expect(m.posts.at(-1).postId).toBe('6'); // oldest five evicted
  });

  it('groups a mixed batch by member', async () => {
    await store.upsertPosts([
      post('1', '42', 'bình luận của bốn hai đủ dài'),
      post('2', '43', 'bình luận của bốn ba đủ dài'),
      post('3', '42', 'bình luận thứ hai của bốn hai'),
    ]);
    expect((await store.getMember('42')).totalPosts).toBe(2);
    expect((await store.getMember('43')).totalPosts).toBe(1);
  });

  it('records distinct thread titles, newest first, capped at 5', async () => {
    for (let i = 1; i <= 7; i++) {
      await store.upsertPosts([post(String(i), '42', `bình luận đủ dài số ${i}`, { thread: `T${i}` })]);
    }
    const m = await store.getMember('42');
    expect(m.threads).toHaveLength(5);
    expect(m.threads[0]).toBe('T7');
    expect(m.threads).not.toContain('T1');
  });

  it('stores a multi-post batch newest-first when the batch arrives oldest-first', async () => {
    // Document order from extractPosts is oldest-first; the window must come out
    // newest-first, or the cap silently discards the most recent posts.
    await store.upsertPosts([
      post('1', '42', 'bình luận đủ dài số một'),
      post('2', '42', 'bình luận đủ dài số hai'),
      post('3', '42', 'bình luận đủ dài số ba'),
    ]);
    expect((await store.getMember('42')).posts.map((p) => p.postId)).toEqual(['3', '2', '1']);
  });

  it('stays idempotent past the cap, so an identical resend changes nothing', async () => {
    const cfg = { maxPostsPerMember: 20 };
    const batch = Array.from({ length: 25 }, (_, i) =>
      post(String(i + 1), '42', `bình luận đủ dài số ${i + 1}`));
    await store.upsertPosts(batch, cfg);
    const first = await store.getMember('42');
    await store.upsertPosts(batch, cfg);
    const second = await store.getMember('42');
    expect(second.totalPosts).toBe(25);
    expect(second.posts.map((p) => p.postId)).toEqual(first.posts.map((p) => p.postId));
  });

  it('records every distinct thread in a mixed batch, newest first', async () => {
    await store.upsertPosts([
      post('1', '42', 'bình luận đủ dài số một', { thread: 'T1' }),
      post('2', '42', 'bình luận đủ dài số hai', { thread: 'T2' }),
      post('3', '42', 'bình luận đủ dài số ba', { thread: 'T3' }),
    ]);
    expect((await store.getMember('42')).threads).toEqual(['T3', 'T2', 'T1']);
  });

  it('does not duplicate an already-known thread title', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài thứ nhất', { thread: 'T' })]);
    await store.upsertPosts([post('2', '42', 'bình luận đủ dài thứ hai', { thread: 'T' })]);
    expect((await store.getMember('42')).threads).toEqual(['T']);
  });

  it('evicts the least recently seen member past maxMembers', async () => {
    const cfg = { maxMembers: 3 };
    for (const id of ['1', '2', '3']) {
      await store.upsertPosts([post('p' + id, id, `bình luận đủ dài số ${id}`)], cfg);
      now += 1000;
    }
    await store.upsertPosts([post('p4', '4', 'bình luận đủ dài số 4')], { maxMembers: 3 });
    expect(await store.getMember('1')).toBeNull();
    expect(await store.getMember('4')).not.toBeNull();
  });
});

describe('setLabel and setError', () => {
  it('stores a label and a null error', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài cho một thành viên')]);
    await store.setLabel('42', { choice: 'troll', probabilities: null, lean: {}, at: now, evidenceCount: 1, labelSetHash: HASH });
    const m = await store.getMember('42');
    expect(m.label.choice).toBe('troll');
    expect(m.lastError).toBeNull();
  });

  it('records an error without dropping the collected posts', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài cho một thành viên')]);
    await store.setError('42', { code: 401, message: 'unauthorized', at: now });
    const m = await store.getMember('42');
    expect(m.lastError.code).toBe(401);
    expect(m.posts).toHaveLength(1);
  });
});

describe('clear and listMembers', () => {
  it('removes every member key', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài một'), post('2', '43', 'bình luận đủ dài hai')]);
    await store.clear();
    expect(await store.listMembers()).toEqual([]);
    expect(await store.getMember('42')).toBeNull();
  });

  it('sorts members by cached post count descending', async () => {
    await store.upsertPosts([post('1', '42', 'bình luận đủ dài một')]);
    await store.upsertPosts([post('2', '43', 'bình luận đủ dài hai')]);
    await store.upsertPosts([post('3', '43', 'bình luận đủ dài ba')]);
    expect((await store.listMembers()).map((m) => m.id)).toEqual(['43', '42']);
  });
});

describe('shouldClassify', () => {
  const m = (over = {}) => ({
    id: '42', name: 'u42', totalPosts: 10,
    posts: Array.from({ length: 10 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
    threads: [], profile: {}, label: null, lastError: null, lastSeenAt: 0,
    ...over,
  });

  it('false when disabled', () => {
    expect(shouldClassify({ member: m(), cfg: normalize({ ...CFG, enabled: false }), now, hash: HASH })).toBe(false);
  });

  it('false without an API key', () => {
    expect(shouldClassify({ member: m(), cfg: normalize({ apiKey: '' }), now, hash: HASH })).toBe(false);
  });

  it('false with no stored posts', () => {
    expect(shouldClassify({ member: m({ posts: [], totalPosts: 0 }), cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('false below the threshold', () => {
    const member = m({ posts: m().posts.slice(0, 5), totalPosts: 5 });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true at the threshold with no label', () => {
    expect(shouldClassify({ member: m(), cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('false when the existing label is fresh', () => {
    const member = m({ label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: HASH } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true when the label set changed', () => {
    const member = m({ label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: 'deadbeef' } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('true when reclassifyEvery new posts have accrued past the cap', () => {
    const member = m({
      totalPosts: 25,
      label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: HASH },
    });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('false when fewer new posts than reclassifyEvery have accrued', () => {
    const member = m({
      totalPosts: 15,
      label: { choice: 'troll', at: now - 1000, evidenceCount: 10, labelSetHash: HASH },
    });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true when labelTtlMs has elapsed', () => {
    const member = m({ label: { choice: 'troll', at: now - 604800000 - 1, evidenceCount: 10, labelSetHash: HASH } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('never expires when labelTtlMs is 0', () => {
    const member = m({ label: { choice: 'troll', at: 0, evidenceCount: 10, labelSetHash: HASH } });
    const cfg = normalize({ ...CFG, labelTtlMs: 0 });
    expect(shouldClassify({ member, cfg, now, hash: HASH })).toBe(false);
  });

  it('false while a recent error is still cooling down', () => {
    const member = m({ lastError: { code: 429, message: 'slow down', at: now - 1000 } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(false);
  });

  it('true once the error cooldown has elapsed', () => {
    const member = m({ lastError: { code: 429, message: 'slow down', at: now - RETRY_AFTER_MS - 1 } });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH })).toBe(true);
  });

  it('force bypasses threshold, freshness, and the error cooldown', () => {
    const member = m({
      posts: m().posts.slice(0, 1), totalPosts: 1,
      label: { choice: 'troll', at: now, evidenceCount: 1, labelSetHash: HASH },
      lastError: { code: 429, message: 'slow down', at: now },
    });
    expect(shouldClassify({ member, cfg: CFG, now, hash: HASH, force: true })).toBe(true);
  });

  it('force still requires an API key and at least one post', () => {
    const noKey = normalize({ apiKey: '' });
    expect(shouldClassify({ member: m(), cfg: noKey, now, hash: HASH, force: true })).toBe(false);
    const noPosts = m({ posts: [], totalPosts: 0 });
    expect(shouldClassify({ member: noPosts, cfg: CFG, now, hash: HASH, force: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/store.test.js`
Expected: FAIL — cannot resolve `../extension/lib/store.js`

- [ ] **Step 3: Implement store.js**

Create `extension/lib/store.js`. `upsertPosts` takes the per-call `cfg` so the caps are testable without threading a config object through the store:

```js
import { DEFAULT_LABELS } from './labels.js';
import { normalize, RETRY_AFTER_MS } from './config.js';

export const MEMBER_PREFIX = 'm:';
const MAX_THREADS = 5;

const key = (id) => `${MEMBER_PREFIX}${id}`;
const emptyMember = (id, name) => ({
  id, name, totalPosts: 0, posts: [], seenIds: [], threads: [], profile: {},
  label: null, lastError: null, lastSeenAt: 0,
});

/** Pure. Decides whether this member is due for a (re-)classification. */
export function shouldClassify({ member, cfg, now, hash, force = false }) {
  if (!member || !cfg.apiKey) return false;
  if (!member.posts || member.posts.length === 0) return false;
  if (force) return true;

  if (!cfg.enabled) return false;
  if (member.posts.length < cfg.threshold) return false;

  const l = member.label;
  if (l) {
    const freshByHash = l.labelSetHash === hash;
    const freshByTtl = !(cfg.labelTtlMs > 0 && now - l.at >= cfg.labelTtlMs);
    const freshByEvidence = (member.totalPosts - l.evidenceCount) < cfg.reclassifyEvery;
    if (freshByHash && freshByTtl && freshByEvidence) return false;
  }

  if (member.lastError && now - member.lastError.at < RETRY_AFTER_MS) return false;
  return true;
}

export function createStore(storage, now = () => Date.now()) {
  const store = {
    async getMember(id) {
      const got = await storage.get(key(id));
      return got[key(id)] || null;
    },

    async getMembers(ids) {
      const keys = ids.map(key);
      const got = await storage.get(keys);
      return ids.map((id) => got[key(id)]).filter(Boolean);
    },

    async listMembers() {
      const all = await storage.get(null);
      return Object.entries(all)
        .filter(([k]) => k.startsWith(MEMBER_PREFIX))
        .map(([, v]) => v)
        .sort((a, b) => b.posts.length - a.posts.length);
    },

    async count() {
      const all = await storage.get(null);
      return Object.keys(all).filter((k) => k.startsWith(MEMBER_PREFIX)).length;
    },

    /** Group by member, dedupe by postId, cap stored posts, evict old members. */
    async upsertPosts(posts, rawCfg) {
      const cfg = normalize(rawCfg);
      const t = now();
      const ids = [...new Set(posts.map((p) => p.memberId))];

      const existing = {};
      for (const m of await store.getMembers(ids)) existing[m.id] = m;
      const created = [];

      const write = {};
      for (const id of ids) {
        const batch = posts.filter((p) => p.memberId === id);
        const prev = existing[id];
        if (!prev) created.push(id);
        const m = prev
          ? {
              ...prev,
              posts: [...prev.posts],
              seenIds: [...(prev.seenIds || [])],
              threads: [...prev.threads],
              profile: { ...prev.profile },
            }
          : emptyMember(id, batch[batch.length - 1].name);

        // `known` spans the stored window AND the ring of recently seen ids, so a
        // post the cap has evicted is not treated as new when its page is re-sent.
        // Without the ring, dedupe only holds below the cap and §4's idempotence
        // claim is false for the members seen most.
        const known = new Set(m.seenIds);
        for (const p of m.posts) known.add(p.postId);

        const addedIds = [];
        // `batch` arrives in document order — oldest first — so unshifting each
        // post in turn leaves `posts` newest-first. Callers must preserve that.
        for (const p of batch) {
          if (known.has(p.postId)) continue;
          known.add(p.postId);
          addedIds.push(p.postId);
          m.posts.unshift({ postId: p.postId, text: p.text, ts: t });
          m.totalPosts += 1;
        }

        if (addedIds.length) {
          m.posts = m.posts.slice(0, cfg.maxPostsPerMember);
          m.seenIds = [...new Set([...addedIds, ...m.seenIds])]
            .slice(0, cfg.maxPostsPerMember * 3);
          // Reversed: the batch is oldest-first, so its last thread is the newest.
          const batchThreads = [...new Set(batch.map((p) => p.thread).filter(Boolean))].reverse();
          m.threads = [...new Set([...batchThreads, ...m.threads])].slice(0, MAX_THREADS);
        }

        const latest = batch[batch.length - 1];
        if (latest.name) m.name = latest.name;
        if (latest.joined) m.profile.joined = latest.joined;
        if (latest.postCount != null) m.profile.postCount = latest.postCount;
        m.lastSeenAt = t;

        write[key(id)] = m;
        existing[id] = m;
      }

      await storage.set(write);

      // Evict only when this call created members, so the scan is rare.
      if (created.length) {
        const all = (await store.listMembers()).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
        const excess = all.length - cfg.maxMembers;
        if (excess > 0) {
          await storage.remove(all.slice(0, excess).map((m) => key(m.id)));
        }
      }

      return Object.values(write);
    },

    async setLabel(id, label) {
      const m = await store.getMember(id);
      if (!m) return null;
      const next = { ...m, label, lastError: null };
      await storage.set({ [key(id)]: next });
      return next;
    },

    async setError(id, error) {
      const m = await store.getMember(id);
      if (!m) return null;
      const next = { ...m, lastError: error };
      await storage.set({ [key(id)]: next });
      return next;
    },

    async clear() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(MEMBER_PREFIX));
      if (keys.length) await storage.remove(keys);
    },
  };

  return store;
}
```

- [ ] **Step 4: Run the store test**

Run: `npx vitest run test/store.test.js`
Expected: PASS, 29 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all suites

- [ ] **Step 6: Commit**

```bash
git add extension/lib/store.js test/store.test.js
git commit -m "feat: member store with dedupe, caps, eviction, and trigger predicate"
```

---

## Task 8: Chip rendering

**Files:**
- Create: `extension/lib/chip.js`
- Test: `test/chip.test.js`

**Interfaces:**
- Consumes: `FAMILY_COLORS` from `lib/labels.js`.
- Produces: `chipText(chip, cfg, now = Date.now()) -> string`, `formatDuration(ms) -> string`, `chipColors(family, dark) -> {bg, fg}`, `buildChipState(member, cfg, now) -> chipState`.
  `chipState` is one of:
  - `{ state:'labeled', key, label, family, probability, lean, cached, seen, expiresAt }` — the label's display name and family are resolved from `cfg.labels`; `expiresAt` is `null` when the TTL is disabled
  - `{ state:'collecting', count, threshold }`
  - `{ state:'error', message, cached, seen }`

- [ ] **Step 1: Write the failing chip test**

Create `test/chip.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { chipText, formatDuration, chipColors, buildChipState } from '../extension/lib/chip.js';
import { normalize } from '../extension/lib/config.js';

const CFG = normalize({ verbose: false });
const VERBOSE = normalize({ verbose: true });
const NOW = 1_700_000_000_000;
const DAY = 86400000;

const labeled = (over = {}) => ({
  id: '1', name: 'alice', totalPosts: 13,
  posts: Array.from({ length: 13 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
  threads: [], profile: {}, lastError: null,
  label: { choice: 'troll', probabilities: { troll: 0.62 }, lean: {}, at: NOW, evidenceCount: 13, labelSetHash: 'h' },
  ...over,
});

describe('formatDuration', () => {
  it('renders days, hours, minutes, and seconds', () => {
    expect(formatDuration(4 * DAY)).toBe('4d');
    expect(formatDuration(3 * 3600000)).toBe('3h');
    expect(formatDuration(2 * 60000)).toBe('2ph');
    expect(formatDuration(45 * 1000)).toBe('45s');
  });

  it('rounds down, so it never claims more time than remains', () => {
    expect(formatDuration(4.9 * DAY)).toBe('4d');
    expect(formatDuration(59 * 60000)).toBe('59ph');
  });

  it('shows 0s for a non-positive duration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('chipColors', () => {
  it('returns the light variant when not dark', () => {
    expect(chipColors('negative', false)).toEqual({ bg: '#fee2e2', fg: '#991b1b' });
  });
  it('returns the dark variant when dark', () => {
    expect(chipColors('negative', true)).toEqual({ bg: '#7f1d1d', fg: '#fecaca' });
  });
  it('falls back to neutral for an unknown family', () => {
    // Literals, not chipColors('neutral', …): comparing the function against
    // itself passes even if it returns undefined for both arguments.
    expect(chipColors('nonsense', false)).toEqual({ bg: '#e2e8f0', fg: '#334155' });
    expect(chipColors('nonsense', true)).toEqual({ bg: '#334155', fg: '#e2e8f0' });
  });

  it('falls back for inherited Object keys, which are truthy but carry no variants', () => {
    // `FAMILY_COLORS[family] || FAMILY_COLORS.neutral` returns Object itself for
    // these, so the fallback never fires and callers reading .bg would throw.
    expect(chipColors('constructor', false)).toEqual(chipColors('neutral', false));
    expect(chipColors('toString', true)).toEqual(chipColors('neutral', true));
  });
});

describe('chipText', () => {
  it('shows label and rounded probability when verbose is off', () => {
    expect(chipText(buildChipState(labeled(), CFG, NOW), CFG)).toBe('Troll 62%');
  });

  it('omits the percentage when probabilities are missing', () => {
    const m = labeled({ label: { ...labeled().label, probabilities: null } });
    expect(chipText(buildChipState(m, CFG, NOW), CFG)).toBe('Troll');
  });

  it('appends cached count and remaining TTL when verbose', () => {
    const m = labeled({ label: { ...labeled().label, at: NOW - 3 * DAY } });
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('Troll 62% · 13 cmt · còn 4d');
  });

  it('shows cached over seen only once past the cap', () => {
    const m = labeled({
      totalPosts: 23,
      posts: Array.from({ length: 20 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
      label: { ...labeled().label, at: NOW },
    });
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('Troll 62% · 20/23 cmt · còn 7d');
  });

  it('shows the infinity mark when the TTL is disabled', () => {
    const cfg = normalize({ verbose: true, labelTtlMs: 0 });
    expect(chipText(buildChipState(labeled(), cfg, NOW), cfg)).toBe('Troll 62% · 13 cmt · ∞');
  });

  it('shows progress and threshold when collecting', () => {
    const m = { id: '1', name: 'bob', totalPosts: 7, posts: Array(7).fill({ postId: 'x', text: 'y'.repeat(30) }), threads: [], profile: {}, label: null, lastError: null };
    expect(chipText(buildChipState(m, CFG, NOW), CFG)).toBe('7/10');
  });

  it('never appends a suffix to a collecting chip, even in verbose', () => {
    const m = { id: '1', name: 'bob', totalPosts: 7, posts: Array(7).fill({ postId: 'x', text: 'y'.repeat(30) }), threads: [], profile: {}, label: null, lastError: null };
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE)).toBe('7/10');
  });

  it('shows a bang and the cached count for an errored member', () => {
    const m = labeled({ label: null, lastError: { code: 401, message: 'API key sai hoặc hết hạn', at: NOW } });
    expect(chipText(buildChipState(m, CFG, NOW), CFG)).toBe('!');
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE)).toBe('! · 13 cmt');
  });
});

describe('buildChipState', () => {
  it('marks an expired label as still labeled, with an expiresAt in the past', () => {
    const m = labeled({ label: { ...labeled().label, at: NOW - 8 * DAY } });
    const s = buildChipState(m, CFG, NOW);
    expect(s.state).toBe('labeled');
    expect(s.expiresAt).toBeLessThan(NOW);
  });

  it('reports expiresAt as null when the TTL is disabled', () => {
    const s = buildChipState(labeled(), normalize({ labelTtlMs: 0 }), NOW);
    expect(s.expiresAt).toBeNull();
  });

  it('carries the lean probabilities through for the tooltip', () => {
    const m = labeled({ label: { ...labeled().label, lean: { proGov: 0.81, proUS: 0.12 } } });
    expect(buildChipState(m, CFG, NOW).lean).toEqual({ proGov: 0.81, proUS: 0.12 });
  });

  it('defaults lean to an empty object when the label predates lean', () => {
    const m = labeled({ label: { ...labeled().label, lean: undefined } });
    expect(buildChipState(m, CFG, NOW).lean).toEqual({});
  });

  it('lets a newer error win over the stale label it failed to refresh', () => {
    const m = labeled({
      label: { ...labeled().label, at: NOW - 8 * DAY },
      lastError: { code: 401, message: 'API key sai hoặc hết hạn', at: NOW },
    });
    const s = buildChipState(m, CFG, NOW);
    expect(s.state).toBe('error');
    expect(s.message).toBe('API key sai hoặc hết hạn');
  });

  it('keeps the label when the last error predates it', () => {
    const m = labeled({
      label: { ...labeled().label, at: NOW },
      lastError: { code: 429, message: 'slow down', at: NOW - 2 * DAY },
    });
    expect(buildChipState(m, CFG, NOW).state).toBe('labeled');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/chip.test.js`
Expected: FAIL — cannot resolve `../extension/lib/chip.js`

- [ ] **Step 3: Implement chip.js**

Create `extension/lib/chip.js`:

```js
import { FAMILY_COLORS } from './labels.js';

const UNITS = [
  ['d', 86400000],
  ['h', 3600000],
  ['ph', 60000],
  ['s', 1000],
];

/** Coarse remaining duration. Rounds down so it never overstates. */
export function formatDuration(ms) {
  if (!(ms > 0)) return '0s';
  for (const [suffix, size] of UNITS) {
    if (ms >= size) return `${Math.floor(ms / size)}${suffix}`;
  }
  return '0s';
}

export function chipColors(family, dark) {
  // hasOwn, not `||`: inherited keys such as 'constructor' and '__proto__' are
  // truthy but carry no .light/.dark, so the fallback would not fire and callers
  // reading .bg would throw.
  const entry = Object.hasOwn(FAMILY_COLORS, family) ? FAMILY_COLORS[family] : FAMILY_COLORS.neutral;
  return dark ? entry.dark : entry.light;
}

/** Turn a member record into the display state the chip renders. */
export function buildChipState(member, cfg, now) {
  const cached = member.posts.length;

  // A label and an error coexist when a re-classification fails: setError keeps
  // the last good label. An error newer than the label must win, or the stale
  // label masks the failure and the error state is unreachable for anyone who
  // has ever been labeled — the member most likely to hit a failed refresh.
  const failedSinceLabel = member.lastError
    && (!member.label || member.lastError.at > member.label.at);

  if (member.label && !failedSinceLabel) {
    const label = (cfg.labels || []).find((l) => l.key === member.label.choice) || null;
    const prob = member.label.probabilities
      ? member.label.probabilities[member.label.choice]
      : undefined;
    return {
      state: 'labeled',
      key: member.label.choice,
      label: label ? label.label : member.label.choice,
      family: label ? label.family : 'neutral',
      probability: typeof prob === 'number' ? prob : null,
      lean: member.label.lean || {},
      cached,
      seen: member.totalPosts,
      expiresAt: cfg.labelTtlMs > 0 ? member.label.at + cfg.labelTtlMs : null,
    };
  }

  if (member.lastError) {
    return { state: 'error', message: member.lastError.message, cached, seen: member.totalPosts };
  }

  return { state: 'collecting', count: cached, threshold: cfg.threshold };
}

export function chipText(chip, cfg, now = Date.now()) {
  const pct = (p) => `${Math.round(p * 100)}%`;

  if (chip.state === 'collecting') {
    // posts.length is already the numerator here, so verbose adds nothing.
    return `${chip.count}/${chip.threshold}`;
  }

  if (chip.state === 'error') {
    return cfg.verbose ? `! · ${chip.cached} cmt` : '!';
  }

  let text = chip.probability == null ? chip.label : `${chip.label} ${pct(chip.probability)}`;
  if (!cfg.verbose) return text;

  text += chip.seen > chip.cached ? ` · ${chip.cached}/${chip.seen} cmt` : ` · ${chip.cached} cmt`;
  if (chip.expiresAt === null) return `${text} · ∞`;
  return `${text} · còn ${formatDuration(chip.expiresAt - now)}`;
}
```

`now` is a parameter rather than a direct `Date.now()` call so the `còn <duration>` rendering is testable without faking the clock. Callers that omit it get the real time.

- [ ] **Step 4: Run the chip test**

Run: `npx vitest run test/chip.test.js`
Expected: PASS, 21 tests (3 formatDuration + 4 chipColors + 8 chipText + 6 buildChipState)

- [ ] **Step 5: Close the spec's predicate assertion in the store suite**

The design spec's §11 testing section requires, among the chip-rendering cases,
"that `verbose` does not change the trigger predicate's output". That assertion
belongs next to the predicate it constrains, so it goes in `test/store.test.js`.
Add:

```js
  it('ignores cfg.verbose, which is display-only', () => {
    const loud = normalize({ ...CFG, verbose: true });
    const quiet = normalize({ ...CFG, verbose: false });
    const at = m();
    const below = m({ posts: m().posts.slice(0, 5), totalPosts: 5 });

    // Same verdict either way, for a member above and below the threshold.
    for (const member of [at, below]) {
      expect(shouldClassify({ member, cfg: loud, now, hash: HASH }))
        .toBe(shouldClassify({ member, cfg: quiet, now, hash: HASH }));
    }
    // And the verdicts are not merely equal by both being false.
    expect(shouldClassify({ member: at, cfg: loud, now, hash: HASH })).toBe(true);
    expect(shouldClassify({ member: below, cfg: loud, now, hash: HASH })).toBe(false);
  });
```

Run: `npx vitest run test/store.test.js`
Expected: PASS, 30 tests

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 100 tests (78 before this task + 21 chip + 1 predicate)

- [ ] **Step 7: Commit**

```bash
git add extension/lib/chip.js test/chip.test.js test/store.test.js
git commit -m "feat: chip state and text rendering with verbose mode"
```

---

## Task 9: Background service worker

**Files:**
- Modify: `extension/background.js` (replaces the skeleton)

**Interfaces:**
- Consumes: `createConfig` from `lib/config.js`; `createStore`, `shouldClassify` from `lib/store.js`; `LEAN_QUESTIONS`, `ARCHETYPE_INSTRUCTIONS`, `labelSetHash` from `lib/labels.js`; `buildState`, `buildQuestions`, `callJev`, `parseAnswer`, `JevHttpError` from `lib/jev.js`; `buildChipState` from `lib/chip.js`.
- Produces: the message handlers `collect`, `force`, `clear`, `rerender` (§4 of the spec) and unsolicited `{ type: 'labels', labels }` broadcasts to the originating tab.

- [ ] **Step 1: Implement the service worker**

Create (replacing) `extension/background.js`:

```js
import { createConfig } from './lib/config.js';
import { createStore, shouldClassify } from './lib/store.js';
import { LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS, labelSetHash } from './lib/labels.js';
import { buildState, buildQuestions, callJev, parseAnswer, JevHttpError } from './lib/jev.js';
import { buildChipState } from './lib/chip.js';

const CONCURRENCY = 2;

const storage = chrome.storage.local;
const cfgStore = createConfig(storage);
const store = createStore(storage);

const queue = [];
const inFlight = new Set();

// Ids whose queued run must ignore threshold, freshness, and the error cooldown
// (spec §8). The flag has to survive into `runOne`: running the predicate there
// without it would drop the very request that queued the member — a `force` from
// a collecting chip is below threshold, one from an error chip is inside
// RETRY_AFTER_MS, and one from a labeled chip is still fresh. All three are
// admitted by the handler's force check and rejected by a plain re-check.
const forced = new Set();

// memberId -> Set<tabId> that asked about it. We push results only to those
// tabs, which is why the extension needs no `tabs` permission (spec §5).
const watchers = new Map();

function watch(memberId, tabId) {
  if (tabId == null) return;
  if (!watchers.has(memberId)) watchers.set(memberId, new Set());
  watchers.get(memberId).add(tabId);
}

function chipFor(member, cfg) {
  return buildChipState(member, cfg, Date.now());
}

async function collectChips(ids) {
  const cfg = await cfgStore.get();
  const members = await store.getMembers(ids);
  const labels = {};
  for (const m of members) labels[m.id] = chipFor(m, cfg);
  return labels;
}

function enqueue(memberId, force = false) {
  // Already in flight: that run is classifying this member right now, so there
  // is nothing left to force. Bailing here (rather than recording the flag) also
  // keeps `forced` from outliving its queue entry.
  if (inFlight.has(memberId)) return;
  if (force) forced.add(memberId);
  if (queue.includes(memberId)) return;   // upgraded in place by the flag above
  queue.push(memberId);
  pump();
}

function pump() {
  while (inFlight.size < CONCURRENCY && queue.length) {
    const id = queue.shift();
    const force = forced.delete(id);   // consumed here, so it cannot leak
    inFlight.add(id);
    runOne(id, force).catch((e) => console.error('[jev] classify failed', id, e))
      .finally(() => { inFlight.delete(id); pump(); });
  }
}

async function runOne(memberId, force = false) {
  const cfg = await cfgStore.get();
  const member = await store.getMember(memberId);
  if (!member) return;

  // Re-checked with the same predicate that queued it: a duplicate enqueue is
  // dropped, but a forced one is not undone by the re-check.
  const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
  if (!shouldClassify({ member, cfg, now: Date.now(), hash, force })) return;

  const state = buildState(member);
  const questions = buildQuestions(cfg.labels, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS);

  let answers;
  try {
    answers = await callJev({ apiKey: cfg.apiKey, modelId: cfg.modelId, state, questions });
  } catch (e) {
    const code = e instanceof JevHttpError ? e.status : 0;
    await store.setError(memberId, { code, message: e.message, at: Date.now() });
    await broadcast(memberId);
    return;
  }

  let parsed;
  try {
    parsed = parseAnswer(answers, cfg.labels);   // throws on an invented choice
  } catch (e) {
    await store.setError(memberId, { code: -1, message: e.message, at: Date.now() });
    await broadcast(memberId);
    return;
  }

  await store.setLabel(memberId, {
    choice: parsed.choice,
    probabilities: parsed.probabilities,
    lean: parsed.lean,
    at: Date.now(),
    evidenceCount: member.totalPosts,
    labelSetHash: hash,
  });
  await broadcast(memberId);
}

async function broadcast(memberId) {
  const tabs = watchers.get(memberId);
  if (!tabs || tabs.size === 0) return;
  const cfg = await cfgStore.get();
  const member = await store.getMember(memberId);
  if (!member) return;
  const chip = chipFor(member, cfg);
  for (const tabId of tabs) {
    chrome.tabs.sendMessage(tabId, { type: 'labels', labels: { [memberId]: chip } })
      .catch(() => {});   // the tab may have navigated away or closed
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'collect') {
        const cfg = await cfgStore.get();
        const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
        const members = await store.upsertPosts(msg.members, cfg);
        const reply = await collectChips(members.map((m) => m.id));
        for (const m of members) {
          watch(m.id, sender.tab && sender.tab.id);
          if (shouldClassify({ member: m, cfg, now: Date.now(), hash })) enqueue(m.id);
        }
        sendResponse({ labels: reply });
        return;
      }

      if (msg.type === 'force') {
        const cfg = await cfgStore.get();
        const hash = labelSetHash(cfg.labels, LEAN_QUESTIONS);
        const member = await store.getMember(msg.memberId);
        if (!member) { sendResponse({ ok: false, error: 'unknown member' }); return; }
        if (!shouldClassify({ member, cfg, now: Date.now(), hash, force: true })) {
          sendResponse({ ok: false, error: cfg.apiKey ? 'no posts collected' : 'missing API key' });
          return;
        }
        watch(msg.memberId, sender.tab && sender.tab.id);
        enqueue(msg.memberId, true);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'clear') {
        await store.clear();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'rerender') {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `unknown message: ${msg.type}` });
    } catch (e) {
      console.error('[jev] message handler failed', msg, e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;   // keep the channel open for the async reply
});
```

- [ ] **Step 2: Run the build to confirm the manifest and worker imports validate**

Run: `npm run build`
Expected: `✓ dist/ built...` — the validator now also scans `background.js`'s static
imports, so it confirms every `lib/` module the worker needs exists.

This does **not** replace Step 4. The build proves the files are present and the
paths resolve; only a real browser proves the worker starts.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. No new tests here — the worker is glue over modules that are already covered.

- [ ] **Step 4: HUMAN CHECKPOINT — worker starts inside Chrome**

Not verifiable outside the browser. Ask the user to:
1. `npm run build`, then reload the extension on `chrome://extensions`
2. Open `chrome://extensions` → the extension → **service worker** link
3. Confirm no import errors in the worker console

Import errors are the classic MV3 failure and show up only here. Do not proceed until the worker starts clean.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js
git commit -m "feat: background worker with store wiring, queue, and message router"
```

---

## Task 10: Content script — scrape and render chips

**Files:**
- Modify: `extension/content.js` (replaces the skeleton)
- Modify: `extension/content.css` (adds the chip classes used below)

**Interfaces:**
- Consumes: `extractPosts` from `lib/voz.js`; `chipText`, `chipColors` from `lib/chip.js`; `createConfig` from `lib/config.js`.
- Produces: chips in the page. No exports — it is a classic script.

- [ ] **Step 1: Implement the content script**

Create (replacing) `extension/content.js`. Note the dynamic imports — content scripts cannot use static `import`:

```js
(async () => {
  const [{ extractPosts, memberIdOf }, { chipText, chipColors }, { createConfig }] = await Promise.all([
    import(chrome.runtime.getURL('lib/voz.js')),
    import(chrome.runtime.getURL('lib/chip.js')),
    import(chrome.runtime.getURL('lib/config.js')),
  ]);

  const cfgStore = createConfig(chrome.storage.local);

  let enabled = true;
  let verbose = false;

  const chips = new Map();   // memberId -> chipState
  const sent = new Set();    // postIds already reported; keeps collect idempotent

  const POST_SEL = 'article.message, [data-content^="post-"]';

  const isDark = () =>
    document.documentElement.getAttribute('data-variation') === 'alternate'
    || window.matchMedia('(prefers-color-scheme: dark)').matches;

  const chipHost = (el) =>
    el.querySelector('.message-name') || el.querySelector('.message-cell--user');

  function renderChip(host, chip, memberId) {
    let node = host.querySelector('.jev-chip');
    if (!node) {
      node = document.createElement('span');
      node.className = 'jev-chip';
      host.appendChild(node);
    }
    node.textContent = chipText(chip, { verbose }, Date.now());
    node.dataset.state = chip.state;
    node.dataset.member = memberId;

    const themed = chip.state === 'labeled';
    const { bg, fg } = chipColors(chip.family || 'neutral', isDark());
    node.style.background = themed ? bg : 'transparent';
    node.style.color = themed ? fg : 'inherit';
    node.classList.toggle('jev-chip--muted', !themed);

    const lean = Object.entries(chip.lean || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
      .join(', ');

    node.title = chip.state === 'labeled'
      ? [
          `${chip.label}${chip.probability != null ? ` ${Math.round(chip.probability * 100)}%` : ''}`,
          `${chip.cached}/${chip.seen} cmt đã lưu`,
          chip.expiresAt !== null
            ? `hết hạn ${new Date(chip.expiresAt).toLocaleString('vi-VN')}`
            : 'không hết hạn',
          lean || null,
        ].filter(Boolean).join(' · ')
      : chip.state === 'error'
        ? chip.message
        : `Đã thu thập ${chip.count}/${chip.threshold} bình luận — bấm để phân loại ngay`;
  }

  /** Idempotent: repaints every post whose member has a state. */
  function paint() {
    for (const el of document.querySelectorAll(POST_SEL)) {
      const memberId = memberIdOf(el);
      const chip = memberId ? chips.get(memberId) : null;
      if (!chip) continue;
      const host = chipHost(el);
      if (host) renderChip(host, chip, memberId);
    }
  }

  async function sendAndPaint(posts) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'collect', members: posts });
      if (!reply || !reply.labels) return;
      for (const [memberId, chip] of Object.entries(reply.labels)) chips.set(memberId, chip);
      paint();
    } catch (e) {
      console.warn('[jev] collect failed', e);
    }
  }

  function scan() {
    if (!enabled) return;
    const posts = extractPosts(document);
    if (!posts.length) return;
    const fresh = posts.filter((p) => !sent.has(p.postId));
    if (!fresh.length) return;
    for (const p of fresh) sent.add(p.postId);
    void sendAndPaint(fresh);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'labels') {
      for (const [memberId, chip] of Object.entries(msg.labels)) chips.set(memberId, chip);
      paint();
      return;
    }
    if (msg.type === 'rerender') {
      // A display-only setting changed. Re-read it and repaint; nothing is refetched.
      void cfgStore.get().then((c) => {
        enabled = c.enabled;
        verbose = c.verbose;
        paint();
      });
    }
  });

  document.addEventListener('click', (e) => {
    const node = e.target.closest('.jev-chip');
    // Labeled chips are informational; only collecting and error chips act on click.
    if (!node || node.dataset.state === 'labeled') return;
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'force', memberId: node.dataset.member })
      .catch((err) => console.warn('[jev] force failed', err));
  }, true);

  const cfg = await cfgStore.get();
  enabled = cfg.enabled;
  verbose = cfg.verbose;
  scan();

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 400);
  }).observe(document.body, { childList: true, subtree: true });

  // Colors are applied inline, so a theme switch needs a repaint.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
})();
```

- [ ] **Step 2: Add the tooltip-capable chip styles**

Replace `extension/content.css` with:

```css
:root {
  --jev-chip-radius: 999px;
  --jev-chip-font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}

.jev-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: var(--jev-chip-radius);
  font: var(--jev-chip-font);
  font-weight: 600;
  white-space: nowrap;
  vertical-align: middle;
  cursor: pointer;
  user-select: none;
}

.jev-chip--muted {
  opacity: 0.75;
  font-weight: 500;
  border: 1px solid currentColor;
}

.jev-chip[data-state="error"] {
  color: #991b1b !important;
  border-color: #991b1b;
}

@media (prefers-color-scheme: dark) {
  .jev-chip[data-state="error"] { color: #fecaca !important; border-color: #fecaca; }
}
```

- [ ] **Step 3: Run the build and the suite**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass. The build's dynamic-import check confirms `content.js` names only modules that exist.

- [ ] **Step 4: HUMAN CHECKPOINT — chips appear on a real thread**

Ask the user to configure the API key first (Task 11), then:
1. Reload the extension, open a voz thread, scroll
2. Confirm collecting chips appear next to author names
3. Confirm that after enough posts accumulate, labels replace the counters

If no chips appear at all, the most likely cause is `SELECTORS` in `lib/voz.js` not matching. Ask the user to run `npm run probe` on that thread again and compare against `SELECTORS`.

- [ ] **Step 5: Commit**

```bash
git add extension/content.js extension/content.css
git commit -m "feat: scrape voz posts and render member chips"
```

---

## Task 11: Popup — verbose list, clear data

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Create: `extension/options.html`
- Create: `extension/options.js`

**Interfaces:**
- Consumes: `createConfig`; `createStore`; `buildChipState`, `chipText` from `lib/chip.js`; `DEFAULT_LABELS`, `LEAN_QUESTIONS` from `lib/labels.js`.
- Produces: the popup and options UIs.

- [ ] **Step 1: Complete the popup**

Replace `extension/popup.html`:

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <style>
    body { width: 300px; margin: 0; padding: 12px;
           font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    label { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    #status { color: #52606d; margin: 10px 0 6px; }
    .warn { color: #991b1b; margin-bottom: 8px; }
    .row { display: flex; justify-content: space-between; gap: 6px;
           padding: 3px 0; border-bottom: 1px solid #e5e7eb; }
    .row b { font-weight: 600; }
    .meta { color: #6b7280; font-size: 11px; }
    #members { max-height: 220px; overflow: auto; margin-top: 8px; }
    button { margin-top: 10px; }
    #empty { color: #6b7280; font-style: italic; }
  </style>
</head>
<body>
  <label><input type="checkbox" id="enabled"> Bật thu thập &amp; phân loại</label>
  <label><input type="checkbox" id="verbose"> Hiện chi tiết cache</label>
  <div id="status">Đang tải…</div>
  <div id="warn" class="warn"></div>
  <div id="members"><div id="empty">Chưa thu thập dữ liệu.</div></div>
  <button id="clear">Xoá dữ liệu đã thu thập</button>
  <button id="options">Cài đặt</button>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

Replace `extension/popup.js`:

```js
import { createConfig } from './lib/config.js';
import { createStore } from './lib/store.js';
import { buildChipState, chipText } from './lib/chip.js';

const $ = (id) => document.getElementById(id);
const cfgStore = createConfig(chrome.storage.local);
const store = createStore(chrome.storage.local);

async function render() {
  const cfg = await cfgStore.get();
  $('enabled').checked = cfg.enabled;
  $('verbose').checked = cfg.verbose;
  $('warn').textContent = cfg.apiKey ? '' : 'Chưa cấu hình API key — chưa thể phân loại.';

  const members = await store.listMembers();
  const labeled = members.filter((m) => m.label).length;
  $('status').textContent =
    `${members.length} thành viên · ${labeled} đã phân loại`;

  const box = $('members');
  box.textContent = '';
  if (!members.length) {
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.textContent = 'Chưa thu thập dữ liệu.';
    box.appendChild(empty);
    return;
  }

  for (const m of members) {
    const chip = buildChipState(m, cfg, Date.now());
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = m.name;
    left.appendChild(name);
    if (chip.state === 'labeled') {
      const tag = document.createElement('span');
      tag.textContent = ` · ${chipText(chip, cfg)}`;
      left.appendChild(tag);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = chip.state === 'collecting'
      ? `chưa phân loại · ${chip.count}/${chip.threshold}`
      : `${chip.cached} cmt`;

    row.append(left, meta);
    box.appendChild(row);
  }
}

$('enabled').addEventListener('change', async (e) => {
  await cfgStore.set({ enabled: e.target.checked });
  await render();
});

$('verbose').addEventListener('change', async (e) => {
  await cfgStore.set({ verbose: e.target.checked });
  // Sent unconditionally, with no URL guard. `tabs.Tab.url` is populated only
  // when the extension has host permission for that tab's URL, and this extension
  // deliberately declares none for voz — it relies on `content_scripts.matches`
  // alone. Whether that alone populates `tab.url` is not something to build a
  // feature on, and guarding on it would silently skip the re-render. A tab with
  // no content script simply rejects, which the catch swallows.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'rerender' }).catch(() => {});
  await render();
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ bình luận và nhãn đã thu thập? Không hoàn tác được.')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
```

- [ ] **Step 2: Create the full options page**

Replace `extension/options.html`:

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>VOZ jev — Cài đặt</title>
  <style>
    body { max-width: 720px; margin: 24px auto; padding: 0 16px;
           font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
    fieldset { margin-bottom: 20px; border: 1px solid #d1d5db; border-radius: 6px; }
    legend { font-weight: 600; padding: 0 6px; }
    label { display: block; margin: 8px 0 2px; }
    input[type=text], input[type=password], input[type=number] { width: 100%; padding: 6px; box-sizing: border-box; }
    input[type=number] { width: 120px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 6px; vertical-align: top; border-bottom: 1px solid #eee; }
    td.desc input { width: 100%; }
    .hint { color: #6b7280; font-size: 12px; }
    .ok { color: #166534; }
    .bad { color: #991b1b; }
  </style>
</head>
<body>
  <h1>VOZ jev — Cài đặt</h1>

  <fieldset>
    <legend>API</legend>
    <label for="apiKey">Vercel AI Gateway API key</label>
    <input type="password" id="apiKey" placeholder="sk-...">
    <label for="modelId">Model ID</label>
    <input type="text" id="modelId">
    <p class="hint">Key chỉ lưu trong máy này. Không bao giờ chia sẻ extension kèm key.</p>
    <button id="test">Kiểm tra kết nối</button>
    <span id="testResult"></span>
  </fieldset>

  <fieldset>
    <legend>Ngưỡng</legend>
    <label for="threshold">Số bình luận tối thiểu để phân loại</label>
    <input type="number" id="threshold" min="1">
    <label for="reclassifyEvery">Phân loại lại sau mỗi N bình luận mới</label>
    <input type="number" id="reclassifyEvery" min="1">
    <label for="ttlDays">Nhãn hết hạn sau (ngày, 0 = không hết hạn)</label>
    <input type="number" id="ttlDays" min="0">
    <label for="maxPostsPerMember">Số bình luận lưu mỗi thành viên</label>
    <input type="number" id="maxPostsPerMember" min="1">
    <label for="maxMembers">Số thành viên lưu tối đa</label>
    <input type="number" id="maxMembers" min="1">
  </fieldset>

  <fieldset>
    <legend>Nhãn</legend>
    <p class="hint">Sửa mô tả sẽ làm nhãn cũ trở nên không so sánh được và chúng sẽ được phân loại lại.</p>
    <table id="labels"></table>
    <button id="addLabel">Thêm nhãn</button>
  </fieldset>

  <button id="save">Lưu</button>
  <span id="saveResult"></span>

  <script type="module" src="options.js"></script>
</body>
</html>
```

Replace `extension/options.js`:

```js
import { createConfig, DEFAULTS } from './lib/config.js';
import {
  FAMILY_COLORS, DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS,
} from './lib/labels.js';
import { buildState, buildQuestions, callJev, parseAnswer } from './lib/jev.js';

const $ = (id) => document.getElementById(id);
const cfgStore = createConfig(chrome.storage.local);
let labels = [];

/**
 * Read a numeric field, falling back to the default when the field is empty or
 * non-numeric. `Number('')` is 0, and `normalize` clamps 0 up to 1 — so a cleared
 * field would silently set the threshold to a single post and make the extension
 * classify on almost no evidence.
 */
const num = (id, fallback) => {
  const raw = $(id).value.trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

function renderLabels() {
  const table = $('labels');
  table.textContent = '';
  labels.forEach((l, i) => {
    const tr = document.createElement('tr');

    const key = document.createElement('td');
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.value = l.key;
    keyInput.pattern = '[a-z0-9_]+';
    keyInput.addEventListener('input', () => { labels[i].key = keyInput.value.trim(); });
    key.appendChild(keyInput);

    const name = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = l.label;
    nameInput.addEventListener('input', () => { labels[i].label = nameInput.value; });
    name.appendChild(nameInput);

    const desc = document.createElement('td');
    desc.className = 'desc';
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = l.description;
    descInput.addEventListener('input', () => { labels[i].description = descInput.value; });
    desc.appendChild(descInput);

    const fam = document.createElement('td');
    const famSelect = document.createElement('select');
    for (const f of Object.keys(FAMILY_COLORS)) {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      if (f === l.family) opt.selected = true;
      famSelect.appendChild(opt);
    }
    famSelect.addEventListener('change', () => { labels[i].family = famSelect.value; });
    fam.appendChild(famSelect);

    const del = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Xoá nhãn';
    delBtn.addEventListener('click', () => {
      if (labels.length <= 1) { alert('Phải còn ít nhất một nhãn.'); return; }
      labels.splice(i, 1);
      renderLabels();
    });
    del.appendChild(delBtn);

    tr.append(key, name, desc, fam, del);
    table.appendChild(tr);
  });
}

async function load() {
  const cfg = await cfgStore.get();
  $('apiKey').value = cfg.apiKey;
  $('modelId').value = cfg.modelId;
  $('threshold').value = cfg.threshold;
  $('reclassifyEvery').value = cfg.reclassifyEvery;
  $('ttlDays').value = Math.round(cfg.labelTtlMs / 86400000);
  $('maxPostsPerMember').value = cfg.maxPostsPerMember;
  $('maxMembers').value = cfg.maxMembers;
  labels = cfg.labels.map((l) => ({ ...l }));
  renderLabels();
}

$('addLabel').addEventListener('click', () => {
  labels.push({ key: 'nhan_moi', label: 'Nhãn mới', family: 'neutral', description: '' });
  renderLabels();
});

$('save').addEventListener('click', async () => {
  const keys = labels.map((l) => l.key);
  if (new Set(keys).size !== keys.length) { alert('Key nhãn bị trùng.'); return; }
  if (keys.some((k) => !/^[a-z0-9_]+$/.test(k))) {
    alert('Key nhãn chỉ được gồm a-z, 0-9 và dấu gạch dưới.');
    return;
  }
  if (labels.some((l) => !l.description.trim())) { alert('Mô tả nhãn không được để trống.'); return; }

  await cfgStore.set({
    apiKey: $('apiKey').value.trim(),
    modelId: $('modelId').value.trim() || 'typesafe-ai/jev',
    threshold: num('threshold', DEFAULTS.threshold),
    reclassifyEvery: num('reclassifyEvery', DEFAULTS.reclassifyEvery),
    labelTtlMs: Math.max(0, num('ttlDays', DEFAULTS.labelTtlMs / 86400000)) * 86400000,
    maxPostsPerMember: num('maxPostsPerMember', DEFAULTS.maxPostsPerMember),
    maxMembers: num('maxMembers', DEFAULTS.maxMembers),
    labels: labels.map((l) => ({ ...l })),
  });
  $('saveResult').textContent = '✓ Đã lưu';
  $('saveResult').className = 'ok';
  await load();
});

$('test').addEventListener('click', async () => {
  const out = $('testResult');
  const cfg = await cfgStore.get();
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { out.textContent = 'Chưa nhập key.'; out.className = 'bad'; return; }
  out.textContent = 'Đang kiểm tra…';
  out.className = '';

  const sample = {
    name: 'test', totalPosts: 2, threads: ['Kiểm tra'],
    posts: [
      { text: 'Theo tôi vấn đề này cần nhìn vào số liệu cụ thể, bác nào có nguồn thì dẫn ra cùng bàn.' },
      { text: 'Nói mãi cũng chỉ có mấy câu đó, chả có dẫn chứng gì cả.' },
    ],
    profile: {},
  };

  try {
    const answers = await callJev({
      apiKey,
      modelId: $('modelId').value.trim() || 'typesafe-ai/jev',
      state: buildState(sample),
      questions: buildQuestions(labels.length ? labels : DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS),
    });
    const parsed = parseAnswer(answers, labels.length ? labels : DEFAULT_LABELS);
    out.textContent = `✓ ${parsed.choice} (${Object.entries(parsed.lean).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ') || 'no lean'})`;
    out.className = 'ok';
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.className = 'bad';
  }
});

load();
```

- [ ] **Step 3: Run the build and the suite**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass.

- [ ] **Step 4: HUMAN CHECKPOINT — configure and verify end to end**

Ask the user to:
1. Reload the extension, open the options page, paste the API key, click **Kiểm tra kết nối** — expect a label, not an error
2. Save, then browse voz threads until a member crosses the threshold
3. Confirm a colored chip appears, its tooltip shows probabilities, and the popup's verbose list shows counts
4. Toggle **Hiện chi tiết cache** and confirm chips gain `· N cmt · còn Xd` without a page reload
5. Confirm **Xoá dữ liệu đã thu thập** empties the popup list, with a confirmation prompt first

- [ ] **Step 5: Commit**

```bash
git add extension/popup.html extension/popup.js extension/options.html extension/options.js
git commit -m "feat: popup verbose list and options page with label editor"
```

---

## Task 12: Verification pass

**Files:** none created. This task confirms the built thing matches the spec.

- [ ] **Step 1: Confirm the dark theme renders correctly**

Ask the user to switch voz between its light and dark themes and confirm chips stay legible in both. If voz's mechanism is not `data-variation`, update the `isDark()` helper in `content.js` to match what the Task 3 probe reported in `theme.htmlAttributes`.

- [ ] **Step 2: Confirm no extra requests to voz**

Open DevTools → Network, filter to `voz.vn`, load a thread, and confirm the extension adds no requests beyond the page's own. This is the spec's central claim (§3) and it is easy to break accidentally.

- [ ] **Step 3: Confirm a hallucinated label is never cached**

Verify by inspection in the service worker console:

```js
chrome.storage.local.get(null).then((all) =>
  Object.entries(all).filter(([k]) => k.startsWith('m:')).map(([, v]) => [v.id, v.label?.choice]));
```

Every `choice` listed must be a key in the current label set (§7). Any that are not mean `parseAnswer` validation was bypassed.

- [ ] **Step 4: Confirm the caps hold under volume**

Ask the user to browse several threads, then check `chrome.storage.local.getBytesInUse()` stays well under the 10MB quota. If it approaches the limit, lower `maxMembers`.

- [ ] **Step 5: Final full run**

Run: `npm test && npm run build`
Expected: all suites pass, build succeeds with no validation problems.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end verification"
```

---

## Notes for the implementer

- **Task 3's checkpoint gates Tasks 4 and 10.** The selectors are the one thing that could not be verified while designing, because voz.vn returns 403 to automated fetches. Treat the probe output as the source of truth and do not guess past it.
- **Task 6's checkpoint gates everything downstream of the gateway.** If the protocol is wrong, fix `lib/jev.js` there, where the loop is one second, rather than debugging it through the extension.
- **`lib/config.js` `normalize()` runs on every read and write.** That is intentional: it means a hand-edited or partially-written config can never produce an out-of-range threshold.
- **`chipText` takes `now` as a parameter** defaulting to `Date.now()`. Passing it explicitly is what makes the `còn <duration>` rendering testable without faking the clock; callers in `content.js` and `popup.js` pass the real time.
- **`background.js` tracks which tab asked about which member** rather than querying tabs by URL. That keeps the extension's permissions at `storage` alone, as the spec requires.
