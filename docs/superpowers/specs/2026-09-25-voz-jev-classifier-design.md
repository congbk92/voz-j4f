# VOZ member classifier — design

**Date:** 2026-09-25
**Status:** approved for planning
**Repo:** `voz-j4f`

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
- A backend server or a bundler. There is no compilation step: the source *is*
  the artifact, and `npm run build` only validates and packages it (§13).
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

The trade is set the other way by default: `threshold` is **1**, so a member is
labeled from their first stored comment rather than after ten, and a member you
meet once does get a verdict. The cost moved from coverage to evidence — one
comment is a thin basis for an archetype, and every new member on a thread is a
call to the gateway. `reclassifyEvery` is **5**, so a label is revisited once
five further comments have accrued; set against the 10 it replaces, that is
roughly twice the re-classification rate for anyone you keep running into.

Both are the user's to trade: raise `threshold` for verdicts resting on more
evidence, raise `reclassifyEvery` to spend less. A `classify now` affordance
(clicking the progress chip) forces a verdict below any threshold, which
preserves the ability to test jev on demand.

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
  classify-cli.mjs    Node CLI: classify a member JSON without the extension
  build.mjs          validates the manifest, copies to dist/, writes a zip
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

### Message protocol

Content script → background:

| message | payload | reply |
|---|---|---|
| `collect` | `{ members: [{ id, name, postId, text, thread, joined, postCount }] }` | `{ labels: { <memberId>: <chipState> } }` |
| `force` | `{ memberId }` | `{ ok, error? }` |
| `clear` | `{}` | `{ ok: true }` |
| `rerender` | `{}` | `{ ok: true }` |

`rerender` is **no longer sent by anything.** Config staleness in an open tab is
handled instead by a `chrome.storage.onChanged` listener in the content script,
which reacts to writes from the popup *and* the options page, and to changes the
popup→tab message could never reach — a threshold or label-set edit made in
options. The message type and both handlers are retained but unreachable; the
next change to this area should delete them together rather than leave the
protocol describing a path nothing walks.

Background → content, unsolicited, after a classification completes:

```js
{ type: 'labels', labels: { <memberId>: <chipState> } }
```

`chipState` is one of:

```js
{ state: 'labeled',    key, label, family, probability, lean, cached, seen, expiresAt }
{ state: 'collecting', count, threshold }
{ state: 'error',      message }
```

A member absent from `labels` gets no chip. `collect` is idempotent — after
dedupe, resending the same page changes nothing — so the content script may send
freely on every navigation and every mutation batch without tracking what it has
already reported.

### Why no bundled SDK

The `ai` package is ~3MB of provider machinery. The one call we need is a plain
REST request, **captured from the installed SDK's `fetch`** — not read from its
source. See the note below for why that distinction cost three attempts:

```
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
  Authorization: Bearer <key>
  Content-Type: application/json
  ai-evaluation-model-specification-version: 4
  ai-gateway-protocol-version: 0.0.1
  ai-gateway-auth-method: api-key
  ai-model-id: typesafe-ai/jev

  { "state": <JSON value>, "questions": { "<id>": <question> }, "providerOptions": {} }

→ 200 { "answers": { "<id>": { "type": "choice", "choice": "troll",
                               "probabilities": { "troll": 0.62, … } } },
        "usage": { … }, "warnings": [ … ] }
```

These four headers were captured by instrumenting the installed SDK's `fetch`, not by
reading its source. That distinction matters: an earlier revision of this spec was
derived by reading `GatewayEvaluationModel.doEvaluate`, which builds only two of
them — the protocol and auth-method headers are assembled in the provider factory
above it. The gateway answered the two-header request with
`400 Unsupported gateway protocol version`, which names the missing header only
obliquely. **Capture the request; do not read it.**

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
  enabled: true,                 // master switch: gates collection AND classification
  verbose: false,                // show confidence, cache counts and expiry under chips
  apiKey: '',                    // empty = collection on, classification paused
  modelId: 'typesafe-ai/jev',
  labels: [ /* see §7 */ ],
  threshold: 1,                  // distinct posts before first classification
  reclassifyEvery: 5,            // new posts since last label before re-running
  maxPostsPerMember: 20,
  maxMembers: 300,
  labelTtlMs: 604800000          // 7d; 0 disables expiry
}
```

`enabled` gates both collection and classification: when it is off, the extension
reads nothing from the page and calls nothing. This bounds the **browsing
pipeline** — collection, classification, and the click-to-force affordance. It does
not gate the options page's "test connection" button, which is an explicit,
labelled diagnostic the user invokes by name to verify a key; gating it on the
master switch would make it untestable exactly when someone is configuring it.
Already-stored data is untouched
and stays visible in the popup's verbose list (§9).

`verbose` is display-only. It changes what chips and the popup render, and never
what is collected, sent, or cached — the trigger predicate (§8) does not read it.

### Member — key `m:<memberId>`

```js
{
  id: '1234567',
  name: 'username',
  totalPosts: 37,                // distinct posts ever seen; monotonic, uncapped
  posts: [ { postId, text, ts } ],  // newest-first, capped at maxPostsPerMember
  seenIds: ['1234567', …],       // recent ids, newest-first, capped at 3×maxPostsPerMember
  profile: { joined: '2019', postCount: 4213 },  // last observed, may be partial
  threads: ['thread title', …],  // up to 5 distinct, newest-first
  label: {
    choice: 'troll',
    probabilities: { troll: 0.62, … },
    lean: { proGov: 0.81, proChina: 0.44, … },   // §8, may be partial
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

`seenIds` exists for the same reason, applied to dedupe. Deduping against
`posts` alone would be enough only while a member is under the cap: past it, the
posts the cap evicted are no longer in `posts`, so re-sending a page would treat
them as new — `totalPosts` would inflate, the freshly re-added old posts would
displace the newest ones in the window, and §4's idempotence claim would be
false for exactly the members that have been seen most. The ring is capped at
three times the post cap, which comfortably exceeds the largest batch one page
can produce.

Eviction: when a *new* member key is created and the member count exceeds
`maxMembers`, drop the least-recently-seen members by `lastSeenAt` until at the
cap. The check runs only on member creation, not on every write.

Worst-case size: `300 × (20 × ~700B + 60 × ~9B) ≈ 4.4MB`, within
`chrome.storage.local`'s 10MB default. No `unlimitedStorage` permission is
needed.

## 7. Label set

Sixteen defaults — the forum's own slang plus a few general archetypes — editable
on the options page. jev takes `criteria` as an arbitrary non-empty map of name →
free-text description, so the whole set is data.

| key | icon | label | family | description |
|---|---|---|---|---|
| `thanh` | 🧠 | Thánh | positive | Kiến thức sâu, dẫn chứng cụ thể, giải đáp thắc mắc cho người khác |
| `nghiem_tuc` | 🧐 | Nghiêm túc | positive | Thảo luận đàng hoàng, trung lập, có lý lẽ, không công kích cá nhân |
| `ca_khia` | 🌶️ | Cà khịa | neutral | Mỉa mai, chọc ngoáy, nói lái — nhưng vẫn có nội dung và quan điểm |
| `spam` | 🤖 | Spam/bot | neutral | Quảng cáo, rao bán, lặp lại một nội dung, hoặc vô nghĩa hoàn toàn |
| `giao_su_mom` | 🎓 | Giáo sư mõm | negative | Thích lên lớp nhưng kiến thức rỗng, nói suông, không dẫn chứng |
| `thanh_chui` | 🤬 | Thánh chửi | negative | Nổi tiếng vì chửi bới, công kích cá nhân, hạ nhục người khác |
| `troll` | 👹 | Troll | negative | Cố tình gây tranh cãi, chọc tức, phá thread, không đóng góp nội dung |
| `trau` | 🐃 | Trẩu / Trẻ trâu | negative | Người trẻ, nông nổi, phát ngôn thiếu chín chắn |
| `wumao` | 💰 | Wumao | negative | Nói sáo rỗng, a dua theo số đông, "bài viết hay quá", không có ý kiến riêng |
| `bo_do` | 🐂 | Bò đỏ | political | Bảo vệ quan điểm Đảng/Nhà nước VN |
| `ro_tau` | 🐉 | Rồ tàu | political | Thân Trung Quốc, bênh vực chính sách TQ |
| `ro_meo` | 🦅 | Rồ mẽo | political | Thân Mỹ, ca ngợi dân chủ phương Tây |
| `ba_que` | 💛 | 3 củ / 3que | political | Chống cộng; gốc "cờ vàng ba sọc" |
| `tu_nhuc` | 🙇 | Tự nhục | political | Tự hạ thấp dân tộc hoặc bản thân người Việt |
| `sinh_ngoai` | ✈️ | Sính ngoại | political | Ưa chuộng nước ngoài quá mức |
| `ech_xanh` | 🐸 | Ếch xanh | political | Ngây thơ, thiếu hiểu biết chính trị |

Colors are assigned **per family**, not per label: four hues (positive, neutral,
negative, political) with light and dark variants. Sixteen distinguishable hues
do not exist, and chasing them would produce chips nobody can tell apart. The
label text always carries the meaning; color is for scanning. Each label stores
its own color in the data, defaulting to its family hue, so the editor can
override any single label.

The political family deliberately shares one hue even though `bo_do` and `ba_que`
are opposites. Distinguishing them by color alone would imply the chip is a
verdict on the view rather than a description of it, and they are only told apart
by reading the label.

`icon` is the one purely cosmetic field: a short string (an emoji by default)
rendered before the label on every chip and popup row. It is editable in the
label editor like any other column, and it is deliberately **not** part of
`labelSetHash` — changing an icon changes nothing about what jev is asked, so it
must not mark cached labels incomparable and trigger a paid re-classification.
Each default label carries a distinct icon, since two labels sharing one would
defeat the point of having them.

Rules the editor enforces:

- `key` is a stable slug, unique, `[a-z0-9_]+`. It is the value jev returns.
- At least one label must remain — jev's `choice` criteria must be non-empty.
- Editing the set changes the question, so labels cached under a different set
  are not comparable. `labelSetHash` hashes the sorted `key:description` pairs
  **and** the `lean` question texts (§8), because changing either changes what
  was asked. A label whose hash differs from the current one is treated as absent.

## 8. Classification

### Trigger

Classify member `m` when **all** of the following hold:

```
cfg.enabled
and cfg.apiKey is non-empty
and m.posts.length >= cfg.threshold
and ( m.label == null
      or m.label.labelSetHash != hash(cfg.labels)
      or m.totalPosts - m.label.evidenceCount >= cfg.reclassifyEvery
      or (cfg.labelTtlMs > 0 and now - m.label.at >= cfg.labelTtlMs) )
and ( m.lastError == null or now - m.lastError.at >= 3600000 )
```

The first three conditions gate the initial classification. The fourth
re-classifies a stale label — the label set changed, enough new evidence
accrued, or the label outlived `labelTtlMs`. Re-classification replaces the
stored label; only the latest label per member is kept.

`cfg.threshold` may not exceed `cfg.maxPostsPerMember`. The options editor clamps
it, because `posts` is capped and a threshold above the cap could never be met.

A **forced** classification (the user clicking a chip) ignores `threshold`,
`reclassifyEvery`, `labelTtlMs`, and `lastError`. It does **not** bypass `enabled`,
`apiKey`, or the requirement for at least one stored post.

`enabled` is checked *before* the force short-circuit, because §7 promises that with
the toggle off the extension "reads nothing from the page and calls nothing" — and a
forced classification spends against the gateway exactly like any other. A master
switch that does not stop spending is not a master switch. The list above is
deliberately exhaustive: anything not named in it is still enforced.

### State

Built from the member record. At most 6 posts, chosen as the **6 longest** of
the stored posts — ranked by original length, *then* each truncated to
**800 characters**. Longest-by-substance rather than most-recent, because the
same token budget buys more signal.

```js
{
  member: 'username',
  joined: '2019',            // omitted when not observed
  postCount: 4213,           // omitted when not observed
  threads: ['…'],            // omitted when empty
  posts: ['…']               // ≤6, each ≤800 chars
}
```

Posts are stored **with quoted blocks removed**, including nested quotes —
XenForo nests `blockquote` elements when a post quotes a post that quoted
another. In XenForo, `blockquote` content is another member's words; storing it
would attach someone else's writing to this member's record permanently, and the
error would compound as more posts accumulate. Quote-stripping is a correctness
requirement, not a nicety.

After stripping, a post whose text is shorter than **15 characters** is not
stored. A post that was nothing but a quote leaves an empty string behind, and
counting it would inflate `totalPosts` toward the threshold with evidence that
does not exist.

### Questions

Two questions in one call. jev scores a map of questions against one shared
state, so asking for more costs output tokens, not another request:

```js
{
  archetype: {
    type: 'choice',
    instructions: 'Phân loại kiểu thành viên diễn đàn dựa trên các bình luận sau. Chỉ dựa vào nội dung bình luận.',
    criteria: { thanh: '…', bo_do: '…', … }        // from cfg.labels
  },
  proGov:          { type: 'boolean', instructions: 'Có bảo vệ quan điểm Đảng/Nhà nước VN không?' },
  proChina:        { type: 'boolean', instructions: 'Có thân Trung Quốc, bênh vực chính sách TQ không?' },
  proUS:           { type: 'boolean', instructions: 'Có thân Mỹ, ca ngợi dân chủ phương Tây không?' },
  antiGov:         { type: 'boolean', instructions: 'Có chống cộng, thái độ với chế độ hiện tại không?' },
  selfDeprecating: { type: 'boolean', instructions: 'Có tự hạ thấp dân tộc hoặc người Việt không?' },
  xenophile:       { type: 'boolean', instructions: 'Có ưa chuộng nước ngoài quá mức không?' },
}
```

**`questions` is a flat map**, and each value must carry its own `type` discriminator —
`choice`, `score`, or `boolean`. Nesting the lean booleans under a `lean` key makes the
gateway read `questions.lean` as a question with no `type`, and it answers
`400 Invalid discriminator value … path: ["questions","lean","type"]`. The lean axes
therefore sit beside `archetype` at the top level, and `parseAnswer` collects every
non-`archetype` answer that parses as a boolean. Verified by capturing the SDK's body,
not by reading its source.

**Why the second question exists.** Seven of the sixteen labels describe political
allegiance, and unlike `troll` vs `thanh` they are not mutually exclusive. Someone
can be a Bò đỏ *and* a Rồ tàu at once — pro-government and pro-China is a
coherent, common position. A single 16-way `choice` forces jev to pick one, so
near-identical evidence would flip between adjacent labels between runs, and the
chip would look unstable for reasons invisible to the user.

The six booleans are independent, so any combination can be high at once, and
each returns its own probability. The chip shows `archetype.choice` — one headline
label — while the tooltip carries the leaning probabilities, which is where the
overlapping detail actually lives.

The `archetype` instructions describe *style and behaviour* and the `lean`
questions carry *politics*, so the two are not competing for the same judgement.
The `lean` texts are code constants, not configuration; `labelSetHash` covers them
so a change to either invalidates cached labels (§7).

### Response handling

`answers.archetype` must be `{ type: 'choice', choice, probabilities? }` and
`choice` must be a key in the criteria that were sent. If the model returns an
unknown choice, the answer is **discarded**, `lastError` is set, and nothing is
cached — a hallucinated label is worse than no label. Missing `probabilities` is
tolerated (the chip renders without a percentage).

Each `lean` answer must be `{ type: 'boolean', probability }` in `[0, 1]`. A
missing or malformed lean answer is dropped **on its own**: the archetype and the
other five leanings are still cached. One bad boolean should not discard a good
label, and `lean` is stored as a partial map for exactly this case.

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

Injected next to each post's author on voz pages. Four states:

- **labeled** — `[👹 TROLL]` in the label's color; the icon and the label are the
  whole chip by default, and verbose adds the numbers as a second line beneath
  it. Tooltip shows the full probability distribution, the six leaning
  probabilities, the evidence count, and when it was classified
- **collecting** — `[7/10]`, muted; clicking forces an immediate classification
- **error** — `[!]`, muted; tooltip carries `lastError.message`, clicking retries
- **nothing** — members with no stored data, and all members when the toggle is off

A label and an error can coexist, because a failed re-classification leaves
`lastError` set while deliberately keeping the last good label — `setError` does
not clear it. So the states are not simply decided in the order above: an error
**newer than the label** wins. Without that rule a stale label permanently masks
the failure, and the error state becomes unreachable for any member that has ever
been labeled — which is precisely the member most likely to hit a failed refresh.
An error older than the label is ignored, since the label then reflects a later,
successful run.

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

### Verbose mode

A toggle in the popup (`cfg.verbose`, default off) that surfaces the cache state
behind each chip.

Three terms, because "cached" is overloaded here:

- **cached comments** — `posts.length`, the comments actually stored for that
  member, i.e. the pool jev draws its 6 posts from
- **seen comments** — `totalPosts`, every distinct comment ever observed; it
  exceeds the cached count only once the member passes `maxPostsPerMember`
- **cache expiry** — `label.at + cfg.labelTtlMs`, the moment the stored label
  goes stale and the next trigger re-classifies it. `labelTtlMs: 0` means never

A chip has a **main line** — the icon and the label — and, when verbose, a
**detail line** stacked *below* it. The label is what you scan past; the numbers
are what you stop on. Percentages stay off the main line because a chip is a
verdict on a member, not a readout: the confidence belongs with the evidence
counts that qualify it, not bolted to the name.

| member state | verbose off | verbose on |
|---|---|---|
| labeled, TTL set | `👹 TROLL` | `👹 TROLL`<br>`62% · 13 cmt · còn 4d` |
| labeled, past the cap | `👹 TROLL` | `👹 TROLL`<br>`62% · 20/23 cmt · còn 4d` |
| labeled, TTL off | `👹 TROLL` | `👹 TROLL`<br>`62% · 13 cmt · ∞` |
| labeled, no probability | `👹 TROLL` | `👹 TROLL`<br>`13 cmt · còn 4d` |
| collecting | `7/10` | `7/10` |
| error | `!` | `!`<br>`13 cmt` |

Surfaces with no room for a second line — popup rows — join the two with ` · `,
so each row above reads as one string there.

The `20/23` form — cached over seen — appears only past the cap. Below it the two
numbers are always equal, so printing both would be noise; the same reason the
collecting row gains nothing, since `posts.length` is already its numerator.

Expiry renders as a coarse remaining duration (`còn 4d`, `còn 3h`, `còn 2ph`).
Exact timestamps live in the tooltip, which carries them in both modes — verbose
exists so the numbers are legible without hovering, not to hide anything.

The popup gains a verbose section: every member with stored data, most comments
first, each row reading `username · 👹 Troll` on the left with its numbers on the
right — `13 cmt · còn 4d` under verbose, the bare count otherwise. Verbose
replaces that count rather than appending to it, so a row never prints the same
number twice. Unlabeled members show `chưa phân loại` in place of label and
expiry. This list renders from stored data regardless of `enabled`, so switching
the extension off does not hide what it already knows.

Toggling verbose writes config, which the content script observes via
`chrome.storage.onChanged` (§4) so chips update
without a page reload.

### Popup

Master toggle (bound to `cfg.enabled`), a status line
(`Đã phân loại 12 thành viên · 3 đang chờ`), a warning row when the API key is
missing or rejected, a "clear collected data" button, and a link to options.

A second toggle (bound to `cfg.verbose`) controls the chips' detail line. It is
disabled and greyed while the master toggle is off, because the page then renders
no chips for it to add detail to — a live-looking control that changes nothing
visible is worse than one that says so. The member list above stays readable in
both states (§Verbose mode).

"Clear collected data" deletes every `m:*` key and leaves `cfg` untouched, so
the key and settings survive. It is destructive and not undoable, so it asks for
confirmation first.

### Options

API key (password field), model id, label set editor, threshold,
reclassify interval, per-member post cap, member cap, label TTL, and a
"test connection" button that classifies a fixed sample string and reports the
result.

## 10. voz.vn markup — verified by probe

**voz.vn returns HTTP 403 to automated fetches**, so the DOM could not be
inspected while designing. The platform is confirmed to be **XenForo**
([W3Techs](https://w3techs.com/sites/info/voz.vn); the official
[VOZ cập nhật 2025](https://voz.vn/t/voz-cap-nhat-2025.1033884/) thread announces
the move to current XenForo), and the 2019 reference extension
[voz-living/chrome-extension-react](https://github.com/voz-living/chrome-extension-react)
is **stale for markup** — its selectors (`table[id^='post']`, `td.alt2`,
`#vB_Editor_001_textarea`) are vBulletin, from before the migration. Its manifest
and options-page patterns remain useful; its DOM layer does not.

**Run on a live thread on 2026-09-25** (`scripts/probe.js`, pasted into the
DevTools console while logged in). `<html data-xf="2.3" data-template="thread_view">`
confirms XenForo 2.3.

| Candidate | Matches | Verdict |
|---|---|---|
| `article.message` | 20 | the post container |
| `[data-content^="post-"]` | 20 | same set; carries `data-content="post-<id>"` |
| `[data-author]` | **25** | 20 posts plus 5 non-post elements — never use this alone as the post selector |
| `.message-content`, `.bbWrapper`, `.message-name` | 20 each | present, as expected |
| `.message-userExtras` | **0** | absent — see below |
| `li.message`, `table[id^="post"]` | 0 | confirms voz's move off vBulletin |
| `.pageNav` / `.p-title-value` | 2 / 1 | pagination and thread title |

A post element's attributes are exactly `class`, `data-author`, `data-content`,
`id`.

**Member links are `/u/<name>.<id>/`, not `/members/`.** voz customises the XenForo
route prefix, so the assumed selector matched nothing and the probe's first run
reported `id: null`. The authoritative source is `data-user-id`, present on both
the avatar link and the username link:

```html
<a href="/u/kido1412.821098/" class="username " data-user-id="821098">kido1412</a>
```

`memberIdOf` therefore reads `[data-user-id]` first and falls back to parsing the
href — which also survives the prefix changing again.

**Join date and post count are not available.** `.message-userExtras` matches
nothing; the user block holds only `message-name` and `userTitle`. Recovering a
join date would mean fetching the member's profile, which this design deliberately
does not do. `buildState` already omits unobserved fields, so nothing breaks — but
`joined`/`postCount` will be absent in practice, and `profileFrom` is defensive
code for other XenForo layouts rather than a path voz exercises.

**Theme.** `<html>` carries `id`, `lang`, `dir`, `data-xf`, `data-app`,
`data-template`, `data-container-key`, `data-content-key`, `data-logged-in`,
`data-cookie-prefix`, `data-csrf`, and a class list — and **no `data-variation`**.
The mechanism this spec originally assumed does not exist on this install. Chip
colours key off `prefers-color-scheme`; the `data-variation` check is kept as a
harmless OR in case a style variation is ever enabled.

**The probe is exploratory, not confirmatory** — it dumps what is there rather
than testing a fixed selector list, which is why it caught both the `/u/` prefix
and the missing `.message-userExtras` that a pass/fail check would have reported
as a bare failure. It reports match counts, the first post's tag/classes/
attributes and a trimmed `outerHTML`, how author id and name are exposed,
pagination structure, and the theme mechanism.

Note: the probe output includes `data-csrf`, a per-session token. Nothing stores
or sends it, but it should not be pasted into shared logs.

## 11. Testing

`vitest` + `jsdom` (new dev dependency; the repo has no test runner today). Only
the pure modules are unit-tested; DOM injection is verified by hand.

- `voz.test.js` — `extractPosts(root)` against a fixture of real post markup
  captured by the probe: author id and name, post id, quote stripping including
  nested quotes, truncation, joined/postCount when present and absent, posts
  under the 15-character floor rejected, empty page returns `[]`.
- `jev.test.js` — `buildState` picks the 6 longest by original length and
  truncates at 800; `buildQuestions` mirrors `cfg.labels`; `parseAnswer` accepts
  a valid answer, rejects an unknown choice, and tolerates missing
  probabilities; `labelSetHash` changes when a description changes.
- `store.test.js` — upsert dedupes by `postId`; `posts` caps at
  `maxPostsPerMember` keeping newest; `totalPosts` stays monotonic past the cap;
  eviction drops least-recently-seen at `maxMembers`; `threshold` clamps to
  `maxPostsPerMember`.
- `config.test.js` — defaults, and that unknown keys survive a round-trip.
- Chip text rendering, one case per row of the verbose table in §9, including the
  `20/23` form appearing only past the cap and the collecting row never growing a
  suffix. Plus a `formatDuration` case per unit, and that `verbose` does not
  change the trigger predicate's output.
- `parseAnswer` with `lean`: a full set, a partial set, a malformed boolean
  dropped while the archetype survives, and a `lean` absent entirely.
- `build.test.mjs` — validation fails, naming every bad path, when the manifest
  references a file that does not exist; passes on the real manifest.
- One trigger-predicate truth table covering every clause: disabled, missing
  key, below threshold, fresh label, changed `labelSetHash`, `reclassifyEvery`
  reached, `labelTtlMs` expired, recent `lastError`, expired `lastError`, and a
  forced classification overriding all of the above.

`scripts/classify-cli.mjs` runs the same `lib/jev.js` from Node against a JSON
file of member data, using the existing `dotenv` + `AI_GATEWAY_API_KEY` setup.
This lets prompt and label iteration happen without reloading the extension,
which matters because prompt tuning is the actual point of the project.

## 12. Privacy and risk

- The API key sits in `chrome.storage.local`. Extension-scoped storage is not
  readable by web pages, but it is not encrypted, and it travels with the
  profile directory. Personal use only; never publish this with a key.
- Several labels name political allegiances (`bo_do`, `ba_que`, `ro_tau`), so the
  output is a per-person political judgement — often a wrong one. That is the
  point of the toy, but it makes "personal use only" about more than the key: the
  stored records and any screenshot of them are the sensitive part. Keep it local,
  and keep the clear-data button (§9) within reach.
- Text from posts on the page — **including other members' words**, not just the
  logged-in user's — is sent to Vercel's AI Gateway. That is inherent to the
  feature and worth stating plainly rather than discovering later.
- The extension makes no requests to voz.vn beyond what the browser already
  does, so it adds no load to the site and does not touch Cloudflare's bot
  detection.

## 13. Build and install

There is no bundler, so the extension source *is* the shipped artifact. The build
command exists to catch the failure that actually bites unpacked extensions — a
`manifest.json` naming a file that does not exist — and to produce a clean
directory to load.

```
npm run build
```

`scripts/build.mjs`:

1. Parse and validate `extension/manifest.json`: valid JSON, `manifest_version: 3`,
   and every path in `content_scripts.js`/`css`, `background.service_worker`, and
   `web_accessible_resources` exists on disk. Fail loudly, listing **every**
   missing path at once rather than the first, so one run reports the whole
   problem.
2. Confirm the `lib/*.js` modules `content.js` dynamically imports exist.
3. Copy `extension/` to `dist/`, replacing it wholesale — no tests, no stray
   files.
4. Zip `dist/` to `dist/voz-jev-<version>.zip`, version read from the manifest.
   For backup and moving to another machine; it is not for the Web Store (§2).

Install:

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `dist/`
4. Open the extension's options page and paste the gateway API key
5. Open a voz thread; the popup toggle turns collection on

After editing any file, click the reload icon on the extension card. There is no
watch mode, because with no bundler there is nothing to rebuild — but Chrome
serves the previously loaded files until you reload, so an edit that "did
nothing" usually means a missed reload.

## 14. Implementation order

1. **Probe** — capture real markup, record selectors and theme mechanism.
2. Extension skeleton: manifest, `config.js`, popup toggle, options shell, and
   `scripts/build.mjs` (§13) so the extension can be loaded from the first commit.
3. `lib/voz.js` + tests, against probe-confirmed markup.
4. `scripts/classify-cli.mjs` — prove the jev round trip from Node, including the
   `archetype` + `lean` questions, before any UI exists. Prompt and label tuning
   happens here.
5. `lib/jev.js` + tests.
6. `lib/store.js` + tests.
7. `background.js` — store wiring, trigger predicate, queue, gateway call.
8. `content.js` + `content.css` — extraction, chips, verbose chip text, dark
   theme, MutationObserver.
9. Popup — master toggle, verbose toggle, verbose per-member cache list. Then the
   options page: label editor, thresholds, caps, test connection.
10. Manual end-to-end on a real thread.
