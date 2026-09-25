# voz-j4f

A Chrome extension that labels members of [voz.vn](https://voz.vn) with an
archetype ("Troll", "Thánh", "Wumao", …), using **jev** through the Vercel AI
Gateway. Personal use — the name is the disclaimer: *voz, just for fun*.

Once a member has posted enough to judge, their name carries a chip with the
label. Labels live in `chrome.storage` on your machine; nothing is sent anywhere
except the posts being classified.

## Install

Chrome will not install a `.zip` — the archive is only how the extension travels.
Installing is four steps, done once:

1. Download `voz-j4f-<version>.zip` from [Releases](../../releases).
2. Extract it to a folder you intend to keep. Chrome reads the extension from
   that folder on every start, so moving or deleting it uninstalls the extension.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select the extracted folder — the one with
   `manifest.json` directly inside it.

Chrome shows a developer-mode warning at startup for unpacked extensions; that is
expected, and **Load unpacked** is the only way to install an extension that is
not in the Chrome Web Store. Dragging a `.crx` in stopped working in Chrome 127.

## Setup

Open the extension's **Options** page and set a Vercel AI Gateway API key
(`sk-…`) and a model ID. The default model is `typesafe-ai/jev`; **Kiểm tra kết
nối** checks the key before you rely on it.

The key is stored in `chrome.storage` on your machine and is *not* part of the
packed archive, so passing the zip on does not pass on your key. Never commit a
key or ship one inside the extension.

## Development

```sh
npm test          # the suite; entirely offline, no key required
npm run build     # validate the manifest, copy extension/ → dist/
npm run pack      # the above, plus dist/voz-j4f-<version>.zip
npm run probe     # dump the voz markup the scraper targets
npm run classify  # classify from the command line (reads .env.local)
```

`npm run build` leaves `dist/` as a load-unpacked folder — point **Load unpacked**
at it to try a build. `npm run pack` additionally writes the release archive.

The CLI scripts read `AI_GATEWAY_API_KEY` from `.env.local`, which is gitignored.
The extension does not use it; the extension's key comes from the options page.

## Releasing

`extension/manifest.json` is the source of truth for the version: the archive is
named from it, and the release refuses to run when the tag disagrees.

1. Bump `version` in `extension/manifest.json`.
2. Commit, then tag and push:

```sh
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` then runs the tests, checks the tag against the
manifest, packs, and attaches `voz-j4f-<version>.zip` to a GitHub Release. Nothing
is published on ordinary commits — only on a `v*` tag.
