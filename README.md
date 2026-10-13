# rmbg-wasm

**Browser WebAssembly background removal and image enhancement.** Give it an
image, get the same image back with the background removed (transparent PNG),
recolored, or edge-refined. Everything runs locally in the browser — no upload,
no server, no API key.

This package exposes the Emscripten/Embind WebAssembly module and the RMBG +
harmonization model weights behind a small, self-contained Worker.

```js
import { removeBackground, colorize, edgeEnhance } from 'rmbg-wasm';

const cutout = await removeBackground(file);            // Blob (transparent PNG)
const colored = await colorize(file);                   // Blob — AI coloring
const edged = await edgeEnhance(file);                  // Blob — edge enhancement
```

## Install

```bash
npm install rmbg-wasm
```

> The package ships the wasm modules (~2.4 MB) and two models (~20 MB total), so
> it is best consumed on the web (bundler / CDN / static hosting) rather than as
> a tiny dependency. The harmonization model is only fetched when `colorize` is
> first used.

## Capabilities

| Function | What it does | Model used |
| --- | --- | --- |
| `removeBackground(image, options?)` | Removes the background | `rmbg.model.tf` (RMBG) |
| `colorize(image, mask?, options?)` / `harmonize` | AI coloring / harmonization | `rmbg.harm.tf` (SSAM) |
| `edgeEnhance(image, mask?, options?)` | Edge enhancement | (no model — wasm routine) |

All three return a full-size RGBA result. `mask` is the subject **cutout**
(RGBA with alpha, e.g. the result of `removeBackground`). When omitted, it is
computed automatically with `removeBackground(image)`.

### API completeness

The shipped WebAssembly module exposes exactly these entry points, and the
package wraps all of them:

| Module surface | Wrapped by |
| --- | --- |
| `Rmbg` · `setParams(bytes)` · `predict(in, out, w, h)` · `setProgressCallback(fn)` | `removeBackground()` (+ `onProgress`) |
| `SSAM` · `setParams(bytes)` · `predict(img, mask, out, w, h)` | `colorize()` / `harmonize()` |
| `_EgdeEnhance(img, mask, out, w, h)` | `edgeEnhance()` |
| `__malloc` / `__free` / `HEAPU8` / `addFunction` | internal plumbing |
| baseline / SIMD / pthread wasm builds | auto-selected (`threads` option) |

There is no other model-facing capability in the module.

## Browser usage

```js
import { removeBackground, colorize, edgeEnhance, load, dispose } from 'rmbg-wasm';

// 1) Background removal — transparent PNG Blob.
const png = await removeBackground(fileOrUrlOrImageData);

// 2) AI coloring: harmonize the subject with its surroundings.
const cutout = await removeBackground(file, { output: 'imageData' });
const colored = await colorize(file, cutout);           // mask explicit

// ...or let the mask be computed for you:
const colored2 = await colorize(file);

// 3) Edge enhancement.
const edged = await edgeEnhance(file, cutout);

// 4) Choose an output format for any of them.
const imageData = await removeBackground(file, { output: 'imageData' }); // ImageData
const bitmap    = await colorize(file, null, { output: 'bitmap' });      // ImageBitmap
const canvas    = await edgeEnhance(file, null, { output: 'canvas' });   // OffscreenCanvas / HTMLCanvasElement

// 5) Track progress and preload.
await load({ onProgress: (state) => console.log(state.phase, state.ratio) });
const blob = await removeBackground(file, {
  onProgress: (state) => console.log(state.phase, state.ratio), // per-phase 0..1
  signal: abortController.signal,
});

// 6) Release the worker when done.
dispose();
```

### Accepted input

`string` (URL) · `Blob` · `File` · `ArrayBuffer` · `ArrayBufferView` ·
`{ data, width, height }` (raw RGBA) · `ImageData` · `ImageBitmap` ·
`HTMLImageElement` · `HTMLCanvasElement` · `OffscreenCanvas`.

### Options

Every function accepts the same options object:

| Option     | Type                                                   | Default            | Description                                            |
| ---------- | ------------------------------------------------------ | ------------------ | ------------------------------------------------------ |
| `output`   | `'blob' \| 'imageData' \| 'arrayBuffer' \| 'uint8array' \| 'bitmap' \| 'canvas'` | `'blob'` | Result format.                        |
| `type`     | `string`                                               | `'image/png'`      | Blob MIME type.                                        |
| `quality`  | `number`                                               | –                  | Blob quality for lossy types.                          |
| `onProgress` | `(state: ProgressState) => void`                     | –                  | Progress callback. Data only — you render the UI.      |
| `progress` | `(state: ProgressState) => void`                       | –                  | Alias of `onProgress`.                                 |
| `signal`   | `AbortSignal`                                          | –                  | Aborts the running job and tears the worker down.      |
| `threads`  | `boolean \| 'auto'`                                    | `'auto'`           | Use the multi-threaded build when the environment allows. |
| `hd`       | `boolean \| { radius, eps, strength }`                 | `false`            | Refine the alpha at full resolution with a local guided filter. |
| `maxSize`  | `number`                                               | `0` (native)       | Cap the long side fed to the model; the matte is upscaled back. |
| `assets`   | `{ glue, wasm, wasmSimd, glueThreaded, pthreadWorker, wasmThreads, wasmSimdThreads, model, harm, modelData, harmModelData }` | bundled assets | Override asset locations (see below).    |

## Node usage (raw RGBA)

Node has no canvas, so the Node entry works with plain RGBA buffers:

```js
import { removeBackground, colorize, edgeEnhance } from 'rmbg-wasm'; // Node entry

const cutout = await removeBackground({ data, width, height });
const colored = await colorize({ data, width, height }, cutout);
const edged = await edgeEnhance({ data, width, height }, cutout);
// each returns { data: Uint8ClampedArray, width, height }
```

Outputs: `'rgba'` (default), `'uint8array'`, `'arrayBuffer'`. Inputs must share
the same dimensions; in Node the mask is not rescaled automatically.

---

## Progress interface

Progress is exposed as **data only** — the package never renders UI. Pass
`onProgress` (alias `progress`) and render whatever you like.

```js
await removeBackground(file, {
  onProgress: (state) => {
    // Blend the raw phase data into a single 0..1 value however you like:
    const pct = state.phase === 'loading' ? state.ratio * 0.3 : 0.3 + state.ratio * 0.7;
    progressEl.value = pct;
    labelEl.textContent = `${state.label} ${Math.round(pct * 100)}%`;
  },
});
```

### `ProgressState`

| Field | Type | Meaning |
| --- | --- | --- |
| `op` | `'removeBackground' \| 'colorize' \| 'edgeEnhance' \| 'batch' \| 'load'` | Operation. |
| `phase` | `'loading' \| 'processing' \| 'done'` | Current stage. |
| `stage` | `'wasm' \| 'model' \| 'harmonization'` (optional) | Download source while `phase === 'loading'`. |
| `value` | `number` | Phase-local numerator (bytes while loading, model steps while processing). |
| `max` | `number` | Phase-local denominator. |
| `ratio` | `number` | `value / max`, `0..1` within the phase. |
| `stageIndex`, `stageCount` | `number` (optional) | Position of the current resource in the preload plan (`phase === 'loading'`). |
| `index`, `count` | `number` (optional) | Present for `batch()` (current item / total). |
| `label` | `string` | Suggested label, e.g. `'Removing background'`. |

Notes:

- `phase: 'loading'` reports the wasm / model **download**; `phase:
  'processing'` reports inference; `phase: 'done'` fires once (`ratio === 1`).
- The package gives you raw phase data only — no blended total. Compose your own
  weighting from `phase` + `ratio` if you want a single bar.
- Granular inference progress comes from the RMBG model (background removal).
  `colorize` / `edgeEnhance` are fast and emit `processing` / `done` only.
- Progress is emitted on every call, including repeated calls.
- When `colorize` / `edgeEnhance` compute the mask for you, the leading states
  have `op: 'removeBackground'` (that is the mask being built), followed by the
  requested operation's states.

### Example: simplest bar

```js
const bar = document.querySelector('#bar');
await removeBackground(file, {
  onProgress: (s) => {
    // e.g. treat phase-local progress as the whole bar:
    bar.value = s.ratio;
  },
});
```

### Example: two-stage UI (download, then processing)

```js
await removeBackground(file, {
  onProgress: (s) => {
    if (s.phase === 'loading') status.textContent = `Downloading ${s.stage}… ${Math.round(s.ratio * 100)}%`;
    else if (s.phase === 'processing') status.textContent = `Processing… ${Math.round(s.ratio * 100)}%`;
    else status.textContent = 'Done';
  },
});
```

### Preloading (initialization progress)

`load()` warms up the runtime ahead of time and reports the same detailed
`ProgressState` stream, so you can render an init progress bar. Each state has
`phase: 'loading'`, a `stage` (`'wasm' | 'model' | 'harmonization'`),
`stageIndex` / `stageCount`, the downloaded `value` / `max` bytes and `ratio`.

```js
import { load } from 'rmbg-wasm';

const info = await load({
  harmonization: true, // also preload the AI-coloring model
  onProgress: (s) => {
    if (s.phase !== 'loading') return;
    // You decide the weighting across resources:
    const pct = (s.stageIndex + s.ratio) / s.stageCount;
    initBar.value = pct;
    initLabel.textContent = `Loading ${s.stage}… ${Math.round(s.ratio * 100)}% (${s.stageIndex + 1}/${s.stageCount})`;
  },
});

console.log(info); // { useSimd, useThreads, stages: ['wasm', 'model', 'harmonization'] }
```

- `harmonization: false` (default) preloads the wasm runtime + RMBG model.
- `harmonization: true` additionally preloads the AI-coloring model, so the
  first `colorize()` is instant.
- The returned `stages` array lists what was loaded, so you can size your bar
  (`stageIndex / stageCount`) without hard-coding.

For `batch()`, `state.index` / `state.count` identify the item; combine them
with `state.ratio` for an aggregate (e.g. `(state.index + state.ratio) /
state.count`).

## How it works

The project ships four wasm builds plus an Emscripten/Embind JS glue. This package
keeps all four and auto-selects at runtime:

| Asset                      | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `rmbg.simd.wasm`           | SIMD build (used when `WebAssembly.validate` supports it) |
| `rmbg.wasm`                | baseline build (fallback)                                 |
| `rmbg.simd.threads.wasm`   | SIMD + pthreads build (multi-threaded mode)               |
| `rmbg.threads.wasm`        | pthreads build (multi-threaded mode, no SIMD)             |
| `rmbg.glue.js`             | Emscripten/Embind runtime (single-threaded)               |
| `rmbg.glue.threaded.js`    | Emscripten/Embind runtime (multi-threaded)                |
| `rmbg.pthread.worker.js`   | pthread pool worker (multi-threaded)                      |
| `rmbg.model.tf`            | RMBG model weights (background removal)                   |
| `rmbg.harm.tf`             | SSAM model weights (AI coloring / harmonization)          |

A Blob Worker loads the glue, instantiates the wasm, creates the Embind objects
and feeds them the model weights. `removeBackground` calls `Rmbg.predict`;
`colorize` lazily creates the `SSAM` object and calls `SSAM.predict(img, mask,
out)`; `edgeEnhance` calls the wasm `_EgdeEnhance(img, mask, out)` routine. The
worker is reused across calls.

## Multi-threaded mode

The pthread-enabled builds are supported and **auto-detected**. When the
page is cross-origin isolated (`crossOriginIsolated === true`, which requires
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`) and `SharedArrayBuffer` exists, the
runtime uses the multi-threaded wasm build and a pthread pool sized to
`navigator.hardwareConcurrency`. It is ~3× faster for background removal and
produces **byte-identical** results to the single-threaded build.

```js
import { load, removeBackground } from 'rmbg-wasm';

const { useSimd, useThreads } = await load(); // e.g. { useSimd: true, useThreads: true }
// or force it off:
const single = await removeBackground(file, { threads: false });
```

- `threads: 'auto'` (default) — use threads when the environment permits.
- `threads: true` — same as `'auto'`.
- `threads: false` — always use the single-threaded build.

To enable it in your app, serve your page with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without those headers the package transparently falls back to single-threaded
mode, so nothing changes for ordinary pages.

## Batch processing

`batch(items, options)` runs many items through one operation, sequentially,
reusing the same worker. It works in the browser and in Node.

```js
import { batch } from 'rmbg-wasm';

const results = await batch(files, {
  op: 'removeBackground',        // or 'colorize' | 'edgeEnhance'
  output: 'blob',
  onProgress: (state) => console.log(state.index + 1, '/', state.count, state.ratio),
  continueOnError: true,
});
// results: [{ ok: true, result }, { ok: false, error }]
```

For `colorize` / `edgeEnhance`, each item is `{ image, mask }`, `[image, mask]`,
or a bare image (mask computed automatically).

### Node CLI

A ready-to-use batch CLI ships with the package (PNG in / PNG out, no extra
dependencies):

```bash
npx rmbg-batch ./input ./output --op remove --recursive
npx rmbg-batch ./input ./output --op colorize --suffix .colored --continue-on-error
```

```
Usage: rmbg-batch <input> <output> [--op remove|colorize|edge] [--recursive]
                   [--suffix .cutout] [--continue-on-error]
```

The raw PNG codec is also exported for custom pipelines:

```js
import { decodePNG, encodePNG } from 'rmbg-wasm/png';
```

## Bundlers / self-hosting assets

By default asset URLs are resolved relative to `src/index.js` using
`import.meta.url`, which works out of the box for:

- plain `<script type="module">` from a CDN (unpkg/jsDelivr/your server),
- Vite dev server,
- Node.

If your bundler hashes/relocates files and does not copy the package's
`assets/` folder, point the package at your own copies:

```js
import wasm from 'rmbg-wasm/assets/rmbg.simd.wasm?url';
import wasmBase from 'rmbg-wasm/assets/rmbg.wasm?url';
import glue from 'rmbg-wasm/assets/rmbg.glue.js?url';
import model from 'rmbg-wasm/assets/rmbg.model.tf?url';
import harm from 'rmbg-wasm/assets/rmbg.harm.tf?url';
// optional, for multi-threaded pages:
import glueThreaded from 'rmbg-wasm/assets/rmbg.glue.threaded.js?url';
import pthreadWorker from 'rmbg-wasm/assets/rmbg.pthread.worker.js?url';
import wasmThreads from 'rmbg-wasm/assets/rmbg.threads.wasm?url';
import wasmSimdThreads from 'rmbg-wasm/assets/rmbg.simd.threads.wasm?url';

await removeBackground(file, {
  assets: { glue, wasm: wasmBase, wasmSimd: wasm, model, harm, glueThreaded, pthreadWorker, wasmThreads, wasmSimdThreads },
});
```

You can also preload the weights yourself and skip the network fetch entirely:

```js
const modelData = await fetch('/my/model.tf').then((r) => r.arrayBuffer());
const harmModelData = await fetch('/my/harm.tf').then((r) => r.arrayBuffer());
await colorize(file, null, { assets: { modelData, harmModelData } });
```

### CSP

The worker is created from a Blob URL and loads the glue with
`importScripts`. If you use a strict Content-Security-Policy, allow
`worker-src blob:` and `script-src` (or `script-src-elem`) for your asset origin.

## Performance

Background removal is CPU-bound. On a 1080×1920 photo it takes ~2.2 s with the
multi-threaded build (~3× faster than single-threaded). AI coloring is much
faster (well under a second on a small image). Model loading happens once per
worker; subsequent calls reuse the same worker.

## High-quality edges (`hd`)

Background removal has two extra, purely local options for full-resolution edge
quality — no server involved:

```js
// Refine the matte at full resolution with an edge-aware guided filter.
const blob = await removeBackground(file, { hd: true });

// Tune the filter (radius in px, eps, and blend strength 0..1).
await removeBackground(file, { hd: { radius: 8, eps: 1e-4, strength: 0.8 } });

// Cap the resolution fed to the model; the matte is upscaled back to native.
// Useful for very large images: inference gets cheaper, layout stays native.
await removeBackground(file, { maxSize: 1024 });
```

- `hd: true` keeps the **original full-resolution pixels** and replaces only the
  alpha channel with a matte snapped to the image's own edges via a guided
  filter (He et al.). This cleans up the soft/blocky halo the CNN leaves around
  hair and fine detail. Pure JS, no wasm — roughly +10–60% time depending on size.
- `maxSize` caps the long side sent to the model. When it triggers, the model
  runs smaller (faster) and the matte is resampled to native resolution — and
  refined too when `hd` is set (a coarse-to-fine / multi-scale scheme).
- Both are opt-in; the default output is the raw model result.

## API

```ts
removeBackground(input, options?): Promise<...>
colorize(image, mask?, options?): Promise<...>
harmonize(image, mask?, options?): Promise<...>   // alias of colorize
edgeEnhance(image, mask?, options?): Promise<...>
batch(items, options?): Promise<Array<{ ok, result?, error? }>>
load(options?): Promise<{ useSimd, useThreads, stages: string[] }>
dispose(): void
isSupported(): boolean
DEFAULT_ASSETS: { glue, wasm, wasmSimd, glueThreaded, pthreadWorker, wasmThreads, wasmSimdThreads, model, harm }
```

See [`src/index.d.ts`](./src/index.d.ts) for full types. `rmbg-wasm/png` exports
`decodePNG` / `encodePNG` (Node only).

## License

[MIT](./LICENSE)
