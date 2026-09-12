# Tab Volume Booster

A Firefox extension that controls the volume of the current tab with a slider
(0–1200 %), plus **Voice boost** and **Bass boost** presets. Nudge the volume
with the arrow keys, and jump to any tab currently playing audio with one click.

It's a Firefox re-build of the idea behind Chrome's "Volume Master".

## How it works

Firefox doesn't support `chrome.tabCapture` the way Chrome does, so this
extension boosts audio the WebExtension-native way:

- When you first move the slider (or pick a preset), the content script routes
  every `<video>`/`<audio>` element on the page through a Web Audio graph:

  ```
  media element -> lowshelf (bass) -> peaking (voice) -> GainNode -> speakers
  ```

- The `GainNode` gives 0–1200 % volume; the two `BiquadFilter`s power the
  Voice/Bass presets.
- The graph is only engaged once you actually change something, so pages sound
  100 % native until then.

**Permissions:** `<all_urls>` (host) + a declared content script so the booster
is reliably present on every normal page, plus `tabs` (to list/switch audible
tabs), `scripting` (to inject into tabs that were already open before the add-on
was installed), and `storage`. The "access your data for all websites" prompt is
expected — a volume booster has to be able to run on whatever site you're on.

### Activation (important)

Firefox blocks the Web Audio `AudioContext` from running until the page has had a
real user interaction (its autoplay policy). The extension therefore:

- never routes audio into a suspended context (so it can **never mute a page**), and
- resumes the context on the first click / keypress / play on the page.

In practice, if you're already watching a video (you pressed play), boosting works
immediately. On a page that started playing entirely on its own, the popup shows
"Click anywhere on the page once to activate the boost" — one click and it engages.

### Known limits

Because it works on the page's own media elements, it can't boost above 100%:

- **cross-origin media without CORS** — the browser hands Web Audio silence for
  these, so the extension detects them and leaves them untouched (you can still
  lower the volume; the popup says when a source can't be boosted),
- audio inside **cross-origin iframes** (some embedded players),
- **DRM/EME** protected streams.

It works on YouTube, Spotify Web, and most video/news sites (their media is
same-origin or CORS-enabled).

## Try it (temporary install)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select this folder's `manifest.json`.
4. Play something (e.g. a YouTube video), click the toolbar icon, drag the slider.

The add-on stays until you restart Firefox.

## Lint / package for publishing

Uses Mozilla's [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/):

```bash
npx web-ext lint        # validate against AMO rules
npx web-ext run         # launch a scratch Firefox with it loaded
npx web-ext build       # produce a .zip in web-ext-artifacts/
```

## Publishing to AMO (addons.mozilla.org)

1. Change the add-on id in `manifest.json`
   (`browser_specific_settings.gecko.id`) to something you own, e.g.
   `tab-volume-booster@yourdomain`.
2. Bump `version` for every submission.
3. Sign in at https://addons.mozilla.org/developers/ and upload the
   `web-ext build` zip (or use `web-ext sign` with API credentials for
   self-distribution).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, Firefox-targeted |
| `content.js` | Web Audio routing + volume/EQ, injected on demand |
| `popup/` | The toolbar UI (HTML/CSS/JS) |
| `icons/icon.svg` | Toolbar icon (Firefox supports SVG icons) |
