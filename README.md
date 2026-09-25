<p align="center">
  <img src="extension/icons/icon.svg" alt="" width="120" height="120">
</p>

# VOZ Chụp Mũ

Labels members of [voz.vn](https://voz.vn) with an archetype ("Troll", "Thánh",
"Wumao", …) using **jev** through the Vercel AI Gateway. Personal use.

*Chụp mũ* — to slap a hat on someone, i.e. to pin a label on them — is what the
extension does to every member it meets. The repo keeps its original name,
`voz-j4f`: *voz, just for fun*.

## Install

Chrome will not install a `.zip`; the archive is only how the extension travels. Once:

1. Download `voz-j4f-<version>.zip` from [Releases](../../releases).
2. Extract it to a folder you'll keep. Chrome loads the extension from that folder on
   every start, so deleting it uninstalls the extension.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and pick the extracted folder — the one with `manifest.json`
   directly inside.

Chrome flags developer-mode extensions at startup; that is expected.

## Setup

In the extension's **Options** page, set a Vercel AI Gateway API key (`sk-…`) and a
model ID (default `typesafe-ai/jev`). The key stays on your machine and is not in the
archive, so passing the zip on does not pass on your key.

## Development

```sh
npm test          # offline, no key needed
npm run build     # validate the manifest, copy extension/ → dist/
npm run icons     # regenerate the icon PNGs after editing extension/icons/icon.svg
npm run pack      # the above, plus dist/voz-j4f-<version>.zip
npm run probe     # dump the voz markup the scraper targets
npm run classify  # classify from the CLI (AI_GATEWAY_API_KEY in .env.local)
```

Point **Load unpacked** at `dist/` to try a build. Tests run in CI on every push and PR.

## Releasing

Bump `version` in `extension/manifest.json` — the release refuses to run when the tag
disagrees — then:

```sh
git tag v0.1.0
git push origin v0.1.0
```

That runs the tests, packs, and attaches the zip to a GitHub Release.
