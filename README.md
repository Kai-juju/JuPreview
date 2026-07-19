# JuPreview

Drag-and-drop footage preview in the browser. Built for one job: letting people
on locked-down Windows laptops play back Canon R5 C-Log3 footage (4K 10-bit
4:2:2 HEVC) that nothing on their machine can open — no installs, no uploads.

Everything runs locally in the visitor's browser. Files never leave their
machine; the site is just static files.

## What it does

- **Drop any clip** (or several — they queue). Normal files (8-bit H.264, or
  HEVC where the machine can decode it) play instantly, untouched.
- **C-Log HEVC 4:2:2 10-bit** gets decoded in the browser by ffmpeg.wasm and
  turned into a smooth 1080p H.264 proxy, with a progress % and speed readout
  while it prepares. ProRes drops work through the same path (and prep faster).
- **LOG | 709 toggle** — a built-in C-Log3 / Cinema Gamut → Rec.709 view
  transform (Canon's published math, constants verified against
  colour-science). For an exact match to your grading LUT, hit **.cube** and
  load Canon's official LUT — it applies in real time.
- **Save proxy** downloads the 1080p H.264 file it made, so a colleague can
  keep a playable copy.
- Space = play/pause · L = toggle LUT · F = fullscreen.

## Deploy to GitHub Pages

1. Create a new repository (e.g. `jupreview`).
2. Push this folder to it **using Git or GitHub Desktop — not the website's
   "upload files" page**. `vendor/core/ffmpeg-core.wasm` is 32.7 MB and the
   web uploader rejects files over 25 MB; a normal `git push` has no such
   limit.

   ```
   git init
   git add .
   git commit -m "JuPreview"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/jupreview.git
   git push -u origin main
   ```

3. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` /
   `(root)` → Save. A minute later the app is live at
   `https://yourname.github.io/jupreview/`.

Notes:

- **First visit reloads the page once, automatically.** That's
  `coi-serviceworker.min.js` switching on cross-origin isolation so ffmpeg can
  use all CPU cores. After that one reload it's silent. If someone's browser
  blocks service workers entirely, the app still works — just slower
  (single-threaded), and the header will say so.
- Keep the empty `.nojekyll` file — it stops GitHub from running the site
  through Jekyll.
- Test on the live Pages URL. Opening `index.html` straight from disk won't
  work (module scripts and service workers need http/https).

## Honest performance expectations

There is no hardware decoder anywhere for 4:2:2 10-bit HEVC, so prep speed is
pure CPU. On a typical corporate laptop expect **prep time roughly 1–3× the
clip length** (a 30 s B-roll ≈ 30–90 s). The speed readout during prep tells
you exactly what that machine is doing. Seconds-long B-roll feels near
instant; for long A-roll, start it and let it cook. Playback after prep is
buttery — it's just a normal 1080p H.264 file at that point.

Very long single takes (~15 min+) can run the browser out of memory during
prep. If that bites, trim the clip, or drop `PREVIEW_HEIGHT` (top of
`app.js`) from `1080` to `720` — the error message in the app says the same.

## Tuning

- `PREVIEW_HEIGHT` in `app.js` — `1080` by default; `720` preps meaningfully
  faster on weak machines.
- Proxy quality lives in the ffmpeg args in `app.js` (`-crf 24`,
  `ultrafast`). Lower CRF = nicer, slower.

## Layout

```
index.html                 UI
app.js                     all logic (player, engine, WebGL LUT pipeline)
coi-serviceworker.min.js   enables multithreading on GitHub Pages
.nojekyll                  keeps GitHub Pages from mangling the site
vendor/ffmpeg/             @ffmpeg/ffmpeg 0.12.15 (ESM)
vendor/core/               @ffmpeg/core-mt 0.12.10 (the actual decoder, 32.7 MB)
```
