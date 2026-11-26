# Chromatogen Batch

`batch.html` is a batch-first front end for the Chromasmith engine: drop a folder, pick one film look, adjust
any frame that needs it, export everything. It is a separate page; `chromasmith-22.html` is not
modified.

## How it works

The page does not contain a renderer. It loads the real app in a hidden frame in its render-only
mode (`chromasmith-22.html?csrender=1`, the same mode the desktop Library uses for edit previews)
and drives it:

| File | Role |
| --- | --- |
| `batch.html` | Page shell and styles. |
| `batch/app.js` | The batch itself: photo list, selection, recipe, export destinations. |
| `batch/engine.js` | The only file that touches the engine. Boots the frame, serialises calls, turns a recipe into the engine's snapshot format, renders previews, runs exports. |
| `batch/zip.js` | Store-only ZIP writer for browsers without folder access. |

Previews call the renderer with the export width (`truncRefW`), so grain and glow look the way the
exported file will at that size. Exports go through the engine's own `exportFX({items})` path, one
photo at a time, so RAW decode, tiling, resize, output sharpening and metadata carry-over are the
editor's code, not a copy.

Because of that, pulling upstream changes into `chromasmith-22.html` updates the looks and the
pipeline here too. If upstream renames a function the bridge relies on, the page says which one at
start-up (`REQUIRED` in `engine.js`).

## Recipes

A recipe is `{ sliders, selects }` in the engine's snapshot vocabulary (`adj-exp`, `sel-lut`, …),
holding only what differs from factory defaults. There is one batch recipe plus an optional
override per photo; a photo's effective recipe is the batch recipe with its override on top. To add
a control, add a row to `SECTIONS` in `app.js` using the engine's slider id.

## Running and testing

```bash
python3 -m http.server 8000        # then open http://localhost:8000/batch.html
node test/batch_smoke.mjs          # loads fixtures, grades, overrides one photo, exports ZIP + folder
```

The page needs http(s): the isolation service worker (needed for RAW) and ES modules do not run
from `file://`.

## Known limits

- Folder export needs the File System Access API (Chrome, Edge, Brave). Elsewhere output is a ZIP,
  split into parts past about 1.5 GB.
- One recipe field per control; masks, curves, crop and rotation are not exposed here — open the
  photo in the editor for those.
- Camera RAW support is whatever the web build of the editor decodes.
