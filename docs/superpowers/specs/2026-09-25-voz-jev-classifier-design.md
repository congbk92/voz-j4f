# VOZ member classifier — design

**Date:** 2026-09-25
**Status:** approved for planning
**Repo:** `try-jev`

## 1. Goal

A Chrome extension that labels members of [voz.vn](https://voz.vn) with a fun
archetype ("Troll", "Thánh", "Wumao", …) using **jev**, the evaluation model
reachable through the Vercel AI Gateway.

The purpose is to exercise jev on real, messy, Vietnamese forum text. Accuracy
is explicitly *not* a goal — this is a toy. That framing drives most of the
decisions below: prefer the simplest mechanism, accept stale and coarse labels,
and never make the user wait.

## 2. Non-goals

- Publishing to the Chrome Web Store. The API key lives in extension storage;
  this is personal use only.
- Supporting any forum other than voz.vn.
- A backend server, a build step, or a bundler.
- Sentiment analysis, moderation, scoring, or any output beyond one archetype
  per member.

## 3. How it works

The extension **accumulates** a member's comments as you browse normally, and
classifies once it has enough. It never fetches anything from voz.vn on its own.

```
you browse voz.vn
  → content script extracts (postId, author, text) from posts on the loaded page
  → background upserts into a per-member store, deduped by postId
  → totalPosts >= threshold?
       no  → chip shows progress (7/10)
       yes → queue a jev call, store the label, chip shows the label
```

This replaced an earlier design that fetched extra pages of the current thread
to build a larger sample. Accumulation is strictly better here: it needs **zero
additional requests** to voz.vn (no Cloudflare exposure, no rate limits, no
"which pages matter" guesswork), and the sample improves the longer you browse
rather than being fixed at whatever one thread happened to contain.

The cost, accepted knowingly: a member you meet once never reaches the threshold
and never gets labeled, and a fresh thread shows progress bars instead of
verdicts. A `classify now` affordance (clicking the progress chip) forces a
verdict immediately, which preserves the ability to test jev on demand.

## 4. Components

```
extension/
  manifest.json      MV3
  background.js      ESM service worker: store, trigger logic, queue, gateway client
  content.js         classic script: DOM glue; dynamic-imports lib/
  content.css        chip styles, light + dark
  popup.html/.js     master toggle, status, link to options
  options.html/.js   key, model, labels, thresholds, storage caps, clear data
  lib/
    voz.js           extractPosts(root) — pure, testable
    store.js         chrome.storage wrapper: upsert, dedupe, caps, eviction
    jev.js           buildState, buildQuestions, callJev, parseAnswer
    config.js        defaults + typed get/set over chrome.storage
    labels.js        default label set
test/                vitest + jsdom
scripts/
  probe.js           DevTools console snippet — dumps real voz DOM structure
  classify-cli.ts    Node CLI: classify a member JSON without the extension
```

### Boundaries

`lib/voz.js` is the only module that knows voz's markup. It takes a `root`
(an element or a parsed `Document`) and returns data; it touches no network and
no chrome API. That single interface is what makes it testable, and it is reused
unchanged for the live page and for the probe.

`lib/jev.js` is the only module that knows the gateway protocol. It takes a
member record and returns a parsed answer; it knows nothing about DOM or storage.

`background.js` is the only place that calls the network, and the only holder of
the queue. Content scripts never touch the gateway.

`content.js` cannot use static ESM imports (content scripts are classic scripts).
It loads shared code with `import(chrome.runtime.getURL('lib/voz.js'))`, and
`lib/*.js` is declared in `web_accessible_resources`.

### Why no bundled SDK

The `ai` package is ~3MB of provider machinery. The one call we need is a plain
REST request, verified against the installed SDK source
(`@ai-sdk/gateway/dist/index.js`, `GatewayEvaluationModel.doEvaluate`):

```
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
  Authorization: Bearer <key>
  Content-Type: application/json
  ai-evaluation-model-specification-version: 4
  ai-model-id: typesafe-ai/jev

  { "state": <JSON value>, "questions": { "<id>": <question> } }

→ 200 { "answers": { "<id>": { "type": "choice", "choice": "troll",
                               "probabilities": { "troll": 0.62, … } } },
        "usage": { … }, "warnings": [ … ] }
```

This runs in the **background service worker**, never the content script. MV3
grants host-permission fetches a CORS exemption; content scripts inherit the
page's origin and get none.

## 5. Permissions

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "host_permissions": ["https://ai-gateway.vercel.sh/*"],
  "content_scripts": [{
    "matches": ["https://voz.vn/*"],
    "js": ["content.js"],
    "css": ["content.css"],
    "run_at": "document_idle"
  }],
  "background": { "service_worker": "background.js", "type": "module" },
  "web_accessible_resources": [{
    "resources": ["lib/*.js"],
    "matches": ["https://voz.vn/*"]
  }]
}
```

No `tabs` permission: results are pushed back using the sender's tab id captured
when the content script messaged us, and `content_scripts.matches` already grants
host access to that tab.

## 6. Data model

All state lives in `chrome.storage.local` under two kinds of key.

### Config — key `cfg`

```js
{
  enabled: true,                 // the popup toggle
  apiKey: '',                    // empty = collection on, classification paused
  modelId: 'typesafe-ai/jev',
  labels: [ /* see §7 */ ],
  threshold: 10,                 // distinct posts before first classification
  reclassifyEvery: 10,           // new posts since last label before re-running
  maxPostsPerMember: 20,
  maxMembers: 300,
  labelTtlMs: 604800000          // 7d; 0 disables expiry
}
```

### Member — key `m:<memberId>`

```js
{
  id: '1234567',
  name: 'username',
  totalPosts: 37,                // distinct posts ever seen; monotonic, uncapped
  posts: [ { postId, text, ts } ],  // newest-first, capped at maxPostsPerMember
  profile: { joined: '2019', postCount: 4213 },  // last observed, may be partial
  threads: ['thread title', …],  // up to 5 distinct, newest-first
  label: {
    choice: 'troll',
    probabilities: { troll: 0.62, … },
    at: 1758787200000,
    evidenceCount: 27,           // totalPosts at classification time
    labelSetHash: 'a1b2c3'
  } | null,
  lastError: null | { code, message, at },
  lastSeenAt: 1758787200000
}
```

`totalPosts` is separate from `posts.length` because `posts` is capped: once a
member has 20 stored posts, `posts.length` stops growing and could never signal
that re-classification is due. `totalPosts` keeps counting distinct posts after
the cap is reached.

Eviction: when a *new* member key is created and the member count exceeds
`maxMembers`, drop the least-recently-seen members by `lastSeenAt` until at the
cap. The check runs only on member creation, not on every write.

Worst-case size: `300 × 20 × ~700B ≈ 4MB`, within `chrome.storage.local`'s 10MB
default. No `unlimitedStorage` permission is needed.

## 7. Label set

Six defaults, editable on the options page. jev takes `criteria` as an arbitrary
non-empty map of name → free-text description, so the whole set is data.

| key | label | color | description |
|---|---|---|---|
| `thanh` | Thánh | `#16a34a` | Kiến thức sâu, dẫn chứng cụ thể, giải đáp thắc mắc cho người khác |
| `nghiem_tuc` | Nghiêm túc | `#2563eb` | Thảo luận đàng hoàng, trung lập, có lý lẽ, không công kích cá nhân |
| `ca_khia` | Cà khịa | `#d97706` | Mỉa mai, chọc ngoáy, nói lái — nhưng vẫn có nội dung và quan điểm |
| `troll` | Troll | `#dc2626` | Phá thread, gây war, công kích cá nhân, không đóng góp nội dung |
| `wumao` | Wumao | `#7c3aed` | Nói sáo rỗng, a dua theo số đông, "bài viết hay quá", không có ý kiến riêng |
| `spam` | Spam/bot | `#64748b` | Quảng cáo, rao bán, lặp lại một nội dung, hoặc vô nghĩa hoàn toàn |

Rules the editor enforces:

- `key` is a stable slug, unique, `[a-z0-9_]+`. It is the value jev returns.
- At least one label must remain — jev's `choice` criteria must be non-empty.
- Editing the set changes the question, so labels cached under a different set
  are not comparable. `labelSetHash` is a hash of the sorted `key:description`
  pairs; a label whose hash differs from the current one is treated as absent.

## 8. Classification

### Trigger

Classify member `m` when **all** of the following hold:

```
cfg.enabled
and cfg.apiKey is non-empty
and m.posts.length >= cfg.threshold
and ( m.label == null
      or m.label.labelSetHash != hash(cfg.labels)
      or m.totalPosts - m.label.evidenceCount >= cfg.reclassifyEvery )
and m.lastError == null or m.lastError is older than 1 hour
```

The first three conditions gate the initial classification. The fourth
re-classifies when the label is stale (label set changed) or when enough new
evidence has accrued. Re-classification replaces the stored label; only the
latest label per member is kept.

### State

Built from the member record. At most 6 posts, chosen as the **6 longest** of
the stored posts, each truncated to **800 characters**. Longest-by-substance
rather than most-recent, because the same token budget buys more signal.

```js
{
  member: 'username',
  joined: '2019',            // omitted when not observed
  postCount: 4213,           // omitted when not observed
  threads: ['…'],            // omitted when empty
  posts: ['…']               // ≤6, each ≤800 chars
}
```

Posts are stored **with quoted blocks removed**. In XenForo, `blockquote`
content is another member's words; storing it would attach someone else's
writing to this member's record permanently, and the error would compound as
more posts accumulate. Quote-stripping is a correctness requirement, not a
nicety.

### Question

```js
{
  archetype: {
    type: 'choice',
    instructions: 'Phân loại kiểu thành viên diễn đàn dựa trên các bình luận sau. Chỉ dựa vào nội dung bình luận.',
    criteria: { thanh: '…', nghiem_tuc: '…', … }   // from cfg.labels
  }
}
```

### Response handling

`answers.archetype` must be `{ type: 'choice', choice, probabilities? }` and
`choice` must be a key in the criteria that were sent. If the model returns an
unknown choice, the answer is **discarded**, `lastError` is set, and nothing is
cached — a hallucinated label is worse than no label. Missing `probabilities` is
tolerated (the chip renders without a percentage).

### Queue

Concurrency 2, owned by `background.js`. A member is enqueued at most once.
Failures retry twice with exponential backoff, then set `lastError` and stop
until the trigger conditions are met again or the user forces a re-run.

| condition | behavior |
|---|---|
| no API key | collection continues; no classification; popup shows a prompt to configure |
| `401` / `403` | `lastError` set; popup shows "API key sai hoặc hết hạn" |
| `429` | backoff, 2 retries, then defer |
| network failure | backoff, 2 retries, then defer |
| choice not in criteria | discard, set `lastError`, log |
| `extractPosts` returns nothing | no error, no message; log once per page load |

## 9. UI

### Chips

Injected next to each post's author on voz pages. Three states:

- **labeled** — `[TROLL 62%]` in the label's color; tooltip shows the full
  probability distribution, the evidence count, and when it was classified
- **collecting** — `[7/10]`, muted; clicking forces an immediate classification
- **nothing** — members with no stored data, and all members when the toggle is off

Chips are inserted into a dedicated container so re-rendering on XenForo's
AJAX navigations does not duplicate them, and a `MutationObserver` handles
infinite scroll and page transitions.

### Dark theme

voz ships light/dark/auto, switchable at runtime (confirmed by the 2025 update
announcement). Chip colors cannot be hardcoded for one theme. Each label defines
a light and a dark variant, and the active variant is selected by the same
mechanism voz uses for its own theme, recorded as a constant in `lib/voz.js`
once the probe reports it. Until the probe runs, the fallback is
`prefers-color-scheme`. Text on every chip uses a light or dark foreground
chosen for contrast against that label's background.

### Popup

Master toggle (bound to `cfg.enabled`), a status line
(`Đã phân loại 12 thành viên · 3 đang chờ`), a warning row when the API key is
missing or rejected, a "clear collected data" button, and a link to options.

### Options

API key (password field), model id, label set editor, threshold,
reclassify interval, per-member post cap, member cap, label TTL, and a
"test connection" button that classifies a fixed sample string and reports the
result.

## 10. Unverified: voz.vn markup

**voz.vn returns HTTP 403 to automated fetches**, so the DOM could not be
inspected while designing. The platform is confirmed to be **XenForo**
([W3Techs](https://w3techs.com/sites/info/voz.vn); the official
[VOZ cập nhật 2025](https://voz.vn/t/voz-cap-nhat-2025.1033884/) thread announces
the move to current XenForo), and the 2019 reference extension
[voz-living/chrome-extension-react](https://github.com/voz-living/chrome-extension-react)
is **stale for markup** — its selectors (`table[id^='post']`, `td.alt2`,
`#vB_Editor_001_textarea`) are vBulletin, from before the migration. Its manifest
and options-page patterns remain useful; its DOM layer does not.

The expected markup family is XenForo 2.x — `article.message[data-author]`,
`data-content="post-NNN"`, `.message-content .bbWrapper`, `.message-userExtras`
— but this is an assumption, not a verified fact, and voz's templates may be
customized.

**Therefore the first implementation task is a probe, not code.** `scripts/probe.js`
is a snippet pasted into the DevTools console on a real voz thread page (logged
in, so no bot wall), which is exploratory rather than confirmatory: it dumps the
actual structure rather than testing a fixed selector list, so it survives
whatever XenForo 2.3 or voz's customizations did. It reports:

- match counts for candidate post containers, author, body, and profile selectors
- the tag, classes, and attributes of the first matching post element, plus a
  trimmed `outerHTML`
- how author id, author name, join date, and post count are exposed
- pagination structure
- **the theme mechanism**: root element classes, `data-*` attributes, and any
  theme key in `localStorage`

Its JSON output is pasted back, and `lib/voz.js` plus the test fixture are
written against what it reports. Until then, the selectors in this spec are
placeholders for a verified value.

## 11. Testing

`vitest` + `jsdom` (new dev dependency; the repo has no test runner today). Only
the pure modules are unit-tested; DOM injection is verified by hand.

- `voz.test.js` — `extractPosts(root)` against a fixture of real post markup
  captured by the probe: author id and name, post id, quote stripping,
  truncation, joined/postCount when present and absent, empty page returns `[]`.
- `jev.test.js` — `buildState` picks the 6 longest and truncates at 800;
  `buildQuestions` mirrors `cfg.labels`; `parseAnswer` accepts a valid answer,
  rejects an unknown choice, and tolerates missing probabilities;
  `labelSetHash` changes when a description changes.
- `store.test.js` — upsert dedupes by `postId`; `posts` caps at
  `maxPostsPerMember` keeping newest; `totalPosts` stays monotonic past the cap;
  eviction drops least-recently-seen at `maxMembers`; the trigger predicate's
  truth table.
- `config.test.js` — defaults, and that unknown keys survive a round-trip.

`scripts/classify-cli.ts` runs the same `lib/jev.js` from Node against a JSON
file of member data, using the existing `dotenv` + `AI_GATEWAY_API_KEY` setup.
This lets prompt and label iteration happen without reloading the extension,
which matters because prompt tuning is the actual point of the project.

## 12. Privacy and risk

- The API key sits in `chrome.storage.local`. Extension-scoped storage is not
  readable by web pages, but it is not encrypted, and it travels with the
  profile directory. Personal use only; never publish this with a key.
- Text from posts on the page — **including other members' words**, not just the
  logged-in user's — is sent to Vercel's AI Gateway. That is inherent to the
  feature and worth stating plainly rather than discovering later.
- The extension makes no requests to voz.vn beyond what the browser already
  does, so it adds no load to the site and does not touch Cloudflare's bot
  detection.

## 13. Implementation order

1. **Probe** — capture real markup, record selectors and theme mechanism.
2. Extension skeleton: manifest, `config.js`, popup toggle, options shell.
3. `lib/voz.js` + tests, against probe-confirmed markup.
4. `scripts/classify-cli.ts` — prove the jev round trip from Node before any
   UI exists.
5. `lib/jev.js` + tests.
6. `lib/store.js` + tests.
7. `background.js` — store wiring, trigger predicate, queue, gateway call.
8. `content.js` + `content.css` — extraction, chips, dark theme, MutationObserver.
9. Options page — label editor, thresholds, caps, test connection.
10. Manual end-to-end on a real thread.
