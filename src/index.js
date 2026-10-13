/**
 * rmbg-wasm — browser WebAssembly background removal and image enhancement.
 *
 * A small, dependency-free API around the shipped Emscripten/Embind
 * WebAssembly module and its model weights:
 *
 *   - removeBackground()  the RMBG model cutout (transparent background)
 *   - colorize()          the AI coloring / harmonization model
 *   - edgeEnhance()       the edge enhancement routine
 *   - batch()             run any of the above over many items
 *
 * Progress is exposed as data, never as UI: pass `onProgress(state)` and render
 * whatever you like. See the `ProgressState` type in index.d.ts.
 *
 * The heavy lifting happens inside a dedicated Worker that runs the shipped
 * Emscripten/Embind WebAssembly module with the model weights. Only one
 * operation runs at a time; calls are queued.
 */
import { workerSource } from './worker.js';
import { guidedFilterAlpha, resizeRgba, resizeFloat01 } from './refine.js';

const ASSET_DIR = new URL('../assets/', import.meta.url);

/** Default asset locations, resolved relative to this module. */
export const DEFAULT_ASSETS = {
  glue: new URL('rmbg.glue.js', ASSET_DIR).href,
  wasm: new URL('rmbg.wasm', ASSET_DIR).href,
  wasmSimd: new URL('rmbg.simd.wasm', ASSET_DIR).href,
  glueThreaded: new URL('rmbg.glue.threaded.js', ASSET_DIR).href,
  pthreadWorker: new URL('rmbg.pthread.worker.js', ASSET_DIR).href,
  wasmThreads: new URL('rmbg.threads.wasm', ASSET_DIR).href,
  wasmSimdThreads: new URL('rmbg.simd.threads.wasm', ASSET_DIR).href,
  model: new URL('rmbg.model.tf', ASSET_DIR).href,
  harm: new URL('rmbg.harm.tf', ASSET_DIR).href,
};

const OP_LABELS = {
  removeBackground: 'Removing background',
  colorize: 'Coloring',
  edgeEnhance: 'Enhancing edges',
  batch: 'Processing',
  load: 'Loading model',
};

let worker = null;
let workerKey = '';
let readyPromise = null;
let readyResolve = null;
let readyReject = null;
let active = null;
let currentReporter = null;
let currentOp = null;
let currentPlan = null;
let preloadResolve = null;
let preloadReject = null;
let chain = Promise.resolve();

/** Order in which resources are fetched, used to report stage position. */
function planFor(op, options) {
  if (op === 'colorize') return ['wasm', 'model', 'harmonization'];
  if (op === 'load') return (options && options.harmonization) ? ['wasm', 'model', 'harmonization'] : ['wasm', 'model'];
  return ['wasm', 'model'];
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') throw new Error('No canvas implementation available');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), type, quality);
  });
}

function isBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

async function drawableFrom(input) {
  if (typeof input === 'string') {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch image (${res.status}): ${input}`);
    return createImageBitmap(await res.blob());
  }
  if (typeof createImageBitmap === 'function') {
    if (isBlob(input)) return createImageBitmap(input);
    if (input instanceof ArrayBuffer) return createImageBitmap(new Blob([input]));
    if (ArrayBuffer.isView(input)) return createImageBitmap(new Blob([input]));
  }
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) return input;
  if (input && typeof input === 'object' && (input.naturalWidth || input.width)) {
    if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement && !input.complete) {
      await new Promise((resolve) => {
        input.addEventListener('load', resolve, { once: true });
        input.addEventListener('error', resolve, { once: true });
      });
    }
    return input;
  }
  throw new TypeError('Unsupported input: expected a URL, Blob, File, ArrayBuffer, TypedArray, ImageData, ImageBitmap, image or canvas element');
}

function drawToImageData(drawable, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(drawable, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function isImageDataLike(value) {
  return !!value && typeof value === 'object' && !!value.data && !!value.width && !!value.height
    && (value.data instanceof Uint8ClampedArray || value.data instanceof Uint8Array);
}

async function toImageData(input) {
  if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    return { data: input.data, width: input.width, height: input.height };
  }
  if (isImageDataLike(input)) {
    return { data: input.data, width: input.width, height: input.height };
  }
  const drawable = await drawableFrom(input);
  const width = drawable.width || drawable.naturalWidth;
  const height = drawable.height || drawable.naturalHeight;
  const imageData = drawToImageData(drawable, width, height);
  if (typeof ImageBitmap !== 'undefined' && drawable instanceof ImageBitmap && drawable !== input) drawable.close();
  return { data: imageData.data, width, height };
}

/** Rescale a mask so it matches the target size. */
function fitMask(mask, width, height) {
  if (mask.width === width && mask.height === height) return mask;
  const source = createCanvas(mask.width, mask.height);
  source.getContext('2d').putImageData(new ImageData(mask.data, mask.width, mask.height), 0, 0);
  const resized = drawToImageData(source, width, height);
  return { data: resized.data, width, height };
}

function sliceBuffer(data) {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

// ---------------------------------------------------------------------------
// Progress interface (data only)
// ---------------------------------------------------------------------------

function progressCallbackOf(options) {
  if (!options) return null;
  const fn = typeof options.onProgress === 'function' ? options.onProgress
    : (typeof options.progress === 'function' ? options.progress : null);
  return fn;
}

/**
 * Returns a reporter for one operation. A reporter exposes a single method,
 * `emit(state)`. When an internal `_progressReporter` is supplied (batch /
 * auto-mask chaining) it forwards to the outer reporter instead of calling the
 * user callback again.
 */
function createReporter(options, op) {
  if (options && options._progressReporter) {
    const outer = options._progressReporter;
    return { emit: (state) => outer.emit(state) };
  }
  const fn = progressCallbackOf(options);
  return {
    emit(state) {
      if (!fn) return;
      try { fn(state); } catch (e) { /* user callback errors are not fatal */ }
    },
  };
}

function loadingState(op, msg) {
  const ratio = msg.total ? msg.loaded / msg.total : 0;
  return {
    op,
    phase: 'loading',
    stage: msg.stage,
    value: msg.loaded,
    max: msg.total || msg.loaded,
    ratio,
    label: OP_LABELS[op] || OP_LABELS.batch,
  };
}

function processingState(op, msg) {
  const ratio = msg.maxVal ? msg.val / msg.maxVal : 0;
  return {
    op,
    phase: 'processing',
    value: msg.val,
    max: msg.maxVal,
    ratio,
    label: OP_LABELS[op] || OP_LABELS.batch,
  };
}

function doneState(op) {
  return { op, phase: 'done', value: 1, max: 1, ratio: 1, label: 'Done' };
}

function reportLoad(msg) {
  if (!currentReporter) return;
  const plan = currentPlan || [];
  const stageIndex = plan.indexOf(msg.stage);
  currentReporter.emit(Object.assign(loadingState(currentOp, msg), {
    stageIndex: stageIndex < 0 ? undefined : stageIndex,
    stageCount: plan.length || undefined,
  }));
}

function reportProcessing(msg) {
  if (currentReporter) currentReporter.emit(processingState(currentOp, msg));
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

function wantsThreads(options) {
  if (!options || options.threads === undefined || options.threads === 'auto') return true;
  return !!options.threads;
}

/**
 * The worker is created from a Blob URL, so it has no base URL of its own.
 * Resolve any relative asset path against the current document first.
 */
function absolutize(url) {
  if (typeof url !== 'string' || url === '') return url;
  try {
    const base = (typeof document !== 'undefined' && document.baseURI)
      ? document.baseURI
      : (typeof location !== 'undefined' ? location.href : undefined);
    return base ? new URL(url, base).href : url;
  } catch (e) {
    return url;
  }
}

const ASSET_KEYS = ['glue', 'glueThreaded', 'pthreadWorker', 'wasm', 'wasmSimd', 'wasmThreads', 'wasmSimdThreads', 'model', 'harm'];

function resolveAssets(options) {
  const raw = Object.assign({}, DEFAULT_ASSETS, options && options.assets);
  const assets = {};
  for (const key of ASSET_KEYS) assets[key] = absolutize(raw[key]);
  if (raw.modelData) assets.modelData = raw.modelData;
  if (raw.harmModelData) assets.harmModelData = raw.harmModelData;
  const threads = wantsThreads(options);
  const key = [
    assets.glue, assets.glueThreaded, assets.pthreadWorker,
    assets.wasm, assets.wasmSimd, assets.wasmThreads, assets.wasmSimdThreads,
    assets.model, assets.harm,
    assets.modelData ? 'model:mem' : '', assets.harmModelData ? 'harm:mem' : '',
    threads ? 'threads' : 'single',
  ].join('|');
  return { assets, key, threads };
}

function teardown(rejectWith) {
  if (worker) {
    try { worker.terminate(); } catch (e) { /* ignore */ }
    worker = null;
  }
  workerKey = '';
  const reject = readyReject;
  readyResolve = readyReject = null;
  readyPromise = null;
  if (active) {
    const a = active;
    active = null;
    if (a.cleanup) a.cleanup();
    a.reject(rejectWith || new Error('Background remover was disposed'));
  }
  if (preloadReject) {
    const rj = preloadReject;
    preloadResolve = preloadReject = null;
    rj(rejectWith || new Error('Background remover was disposed'));
  }
  if (reject && rejectWith) reject(rejectWith);
}

function failActive(error) {
  if (active) {
    const job = active;
    active = null;
    if (job.cleanup) job.cleanup();
    job.reject(error);
    return true;
  }
  if (preloadReject) {
    const rj = preloadReject;
    preloadResolve = preloadReject = null;
    rj(error);
    return true;
  }
  if (readyReject) {
    const reject = readyReject;
    readyResolve = readyReject = null;
    worker = null;
    workerKey = '';
    readyPromise = null;
    reject(error);
    return true;
  }
  return false;
}

function ensureWorker(assets, key, threads) {
  if (worker && workerKey === key) return readyPromise;
  teardown();

  workerKey = key;
  readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  const blob = new Blob([workerSource], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  worker = new Worker(url);
  URL.revokeObjectURL(url);

  worker.onmessage = (event) => {
    const msg = event.data;
    switch (msg.cmd) {
      case 'Init':
        if (readyResolve) readyResolve({ useSimd: !!msg.useSimd, useThreads: !!msg.useThreads });
        break;
      case 'loadProgress':
        reportLoad(msg);
        break;
      case 'preloaded':
        if (preloadResolve) {
          const r = preloadResolve;
          preloadResolve = preloadReject = null;
          r();
        }
        break;
      case 'progressCB':
        reportProcessing(msg);
        break;
      case 'result': {
        const job = active;
        active = null;
        if (job) {
          if (job.cleanup) job.cleanup();
          job.resolve({ width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.data) });
        }
        break;
      }
      case 'error': {
        const error = new Error(msg.msg || 'Operation failed');
        error.code = msg.code;
        failActive(error);
        break;
      }
      default:
        break;
    }
  };
  worker.onerror = (event) => failActive(new Error(event.message || 'Worker error'));

  worker.postMessage({
    cmd: 'config',
    glue: assets.glue,
    glueThreaded: assets.glueThreaded,
    pthreadWorker: assets.pthreadWorker,
    wasm: assets.wasm,
    wasmSimd: assets.wasmSimd,
    wasmThreads: assets.wasmThreads,
    wasmSimdThreads: assets.wasmSimdThreads,
    model: assets.model,
    harmModel: assets.harm,
    modelData: assets.modelData,
    harmModelData: assets.harmModelData,
    threads: threads !== false,
  });

  return readyPromise;
}

function runCommand(cmd, imageData, maskData, options) {
  return new Promise((resolve, reject) => {
    const job = { resolve, reject, cleanup: null };

    const signal = options.signal;
    if (signal) {
      if (signal.aborted) { reject(new Error('Aborted')); return; }
      const onAbort = () => teardown(new Error('Aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      job.cleanup = () => signal.removeEventListener('abort', onAbort);
    }

    active = job;

    const transfer = [];
    const imgBuffer = sliceBuffer(imageData.data);
    transfer.push(imgBuffer);
    const msg = { cmd, width: imageData.width, height: imageData.height };
    if (cmd === 'predict') {
      msg.data = imgBuffer;
    } else {
      msg.imgData = imgBuffer;
      const maskBuffer = sliceBuffer(maskData.data);
      msg.maskImgData = maskBuffer;
      transfer.push(maskBuffer);
    }
    worker.postMessage(msg, transfer);
  });
}

async function formatResult(result, options) {
  const output = options.output || 'blob';
  if (output === 'imageData') return new ImageData(result.data, result.width, result.height);
  if (output === 'arrayBuffer') return result.data.buffer;
  if (output === 'uint8array') return new Uint8Array(result.data.buffer);
  if (output === 'bitmap') return createImageBitmap(new ImageData(result.data, result.width, result.height));
  const canvas = createCanvas(result.width, result.height);
  canvas.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
  if (output === 'canvas') return canvas;
  return canvasToBlob(canvas, options.type || 'image/png', options.quality);
}

function exclusive(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function withReporter(op, options, task) {
  const reporter = createReporter(options, op);
  currentReporter = reporter;
  currentOp = op;
  currentPlan = planFor(op, options);
  try {
    const result = await task();
    reporter.emit(doneState(op));
    return result;
  } finally {
    currentReporter = null;
    currentOp = null;
    currentPlan = null;
  }
}

/**
 * Multi-scale compositing: keep the original full-resolution RGB and replace its
 * alpha with the model matte (resampled if needed, optionally refined).
 */
function composeWithMatte(src, model, refineOptions) {
  const width = src.width, height = src.height;
  let alpha;
  if (model.width === width && model.height === height) {
    alpha = new Float32Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = model.data[i * 4 + 3] / 255;
  } else {
    const small = new Float32Array(model.width * model.height);
    for (let i = 0; i < small.length; i++) small[i] = model.data[i * 4 + 3] / 255;
    alpha = resizeFloat01(small, model.width, model.height, width, height);
  }
  if (refineOptions) alpha = guidedFilterAlpha(src.data, alpha, width, height, refineOptions);
  const out = new Uint8ClampedArray(width * height * 4);
  out.set(src.data);
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = Math.round(alpha[i] * 255);
  return { width, height, data: out };
}

/**
 * Remove the background from an image.
 *
 * @param {RmbgInput} input
 * @param {RemoveBackgroundOptions} [options]
 * @returns {Promise<Blob|ImageData|ArrayBuffer|Uint8Array|ImageBitmap|OffscreenCanvas|HTMLCanvasElement>}
 */
export function removeBackground(input, options = {}) {
  const { assets, key, threads } = resolveAssets(options);
  return exclusive(() => withReporter('removeBackground', options, async () => {
    await ensureWorker(assets, key, threads);
    const src = await toImageData(input);

    // Optionally cap the resolution fed to the model (performance knob).
    const maxSize = options.maxSize || 0;
    const longSide = Math.max(src.width, src.height);
    let modelInput = src;
    if (maxSize && longSide > maxSize) {
      const scale = maxSize / longSide;
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      modelInput = { data: resizeRgba(src.data, src.width, src.height, w, h), width: w, height: h };
    }

    const result = await runCommand('predict', modelInput, null, options);

    const hd = options.hd;
    const refineOptions = hd === true ? {} : (hd && typeof hd === 'object' ? hd : null);
    const resized = modelInput.width !== src.width || modelInput.height !== src.height;
    if (refineOptions || resized) {
      return formatResult(composeWithMatte(src, result, refineOptions), options);
    }
    return formatResult(result, options);
  }));
}

async function enhance(op, image, mask, options) {
  const { assets, key, threads } = resolveAssets(options);
  const imageData = await toImageData(image);
  const reporter = createReporter(options, op);
  let maskData;
  if (mask == null) {
    // Forward the mask computation's progress but drop its terminal `done`
    // (the operation is not finished yet).
    const maskReporter = { emit: (state) => { if (state.phase !== 'done') reporter.emit(state); } };
    maskData = await removeBackground(imageData, {
      output: 'imageData',
      assets: options.assets,
      threads: options.threads,
      _progressReporter: maskReporter,
    });
  } else {
    maskData = await toImageData(mask);
  }
  const fitted = fitMask(maskData, imageData.width, imageData.height);
  return exclusive(() => {
    currentReporter = reporter;
    currentOp = op;
    return (async () => {
      try {
        await ensureWorker(assets, key, threads);
        reporter.emit({ op, phase: 'processing', value: 0, max: 1, ratio: 0, label: OP_LABELS[op] });
        const result = await runCommand(op, imageData, fitted, options);
        reporter.emit(doneState(op));
        return formatResult(result, options);
      } finally {
        currentReporter = null;
        currentOp = null;
      }
    })();
  });
}

/**
 * AI color harmonization: recolors `image` guided by
 * the subject `mask`.
 *
 * @param {RmbgInput} image The image to harmonize (often subject over a background).
 * @param {RmbgInput} [mask] The subject cutout (RGBA with alpha). When omitted it
 *   is computed with `removeBackground(image)`.
 * @param {RemoveBackgroundOptions} [options]
 */
export function colorize(image, mask, options = {}) {
  return enhance('colorize', image, mask, options);
}

/** Alias of {@link colorize}. */
export const harmonize = colorize;

/**
 * Edge enhancement: refines the edge/matting between the subject and the
 * background of `image`, using the subject `mask`.
 *
 * @param {RmbgInput} image
 * @param {RmbgInput} [mask] Subject cutout. Auto-computed when omitted.
 * @param {RemoveBackgroundOptions} [options]
 */
export function edgeEnhance(image, mask, options = {}) {
  return enhance('edgeEnhance', image, mask, options);
}

/**
 * Process many items sequentially (the worker runs one operation at a time).
 * Progress states carry `index` and `count`.
 *
 * @param {Array} items
 * @param {BatchOptions} [options]
 * @returns {Promise<Array<{ok:true, result:any}|{ok:false, error:Error}>>}
 */
export async function batch(items, options = {}) {
  const op = options.op || 'removeBackground';
  const target = op === 'colorize' ? colorize : op === 'edgeEnhance' ? edgeEnhance : removeBackground;
  const continueOnError = !!options.continueOnError;
  const count = Array.isArray(items) ? items.length : 0;
  const reporter = createReporter(options, 'batch');
  const results = [];

  const baseOptions = Object.assign({}, options);
  delete baseOptions.op;
  delete baseOptions.onProgress;
  delete baseOptions.progress;
  delete baseOptions.continueOnError;

  for (let i = 0; i < count; i++) {
    if (options.signal && options.signal.aborted) throw new Error('Aborted');
    const itemOptions = Object.assign({}, baseOptions, {
      _progressReporter: {
        emit(state) {
          // Drop the per-item terminal state; batch reports item completion below.
          if (state.phase === 'done') return;
          reporter.emit(Object.assign({}, state, { op: 'batch', index: i, count }));
        },
      },
    });
    const item = items[i];
    try {
      let result;
      if (op === 'removeBackground') result = await target(item, itemOptions);
      else if (Array.isArray(item)) result = await target(item[0], item[1], itemOptions);
      else if (item && typeof item === 'object' && 'image' in item) result = await target(item.image, item.mask, itemOptions);
      else result = await target(item, undefined, itemOptions);
      results.push({ ok: true, result });
    } catch (error) {
      if (!continueOnError) throw error;
      results.push({ ok: false, error });
    } finally {
      reporter.emit({ op: 'batch', phase: 'processing', value: i + 1, max: count, ratio: count ? (i + 1) / count : 1, index: i, count, label: OP_LABELS.batch });
    }
  }
  reporter.emit({ op: 'batch', phase: 'done', value: count, max: count, ratio: 1, label: 'Done' });
  return results;
}

function preloadHarmonization() {
  return new Promise((resolve, reject) => {
    preloadResolve = resolve;
    preloadReject = reject;
    worker.postMessage({ cmd: 'preload' });
  });
}

/**
 * Preload runtime resources so later operations do not pay the download cost.
 *
 * Reports detailed progress through `onProgress` / `progress`, with
 * `phase: 'loading'`, `stage` (`'wasm' | 'model' | 'harmonization'`),
 * `stageIndex` / `stageCount`, `value` / `max` (bytes) and `ratio`.
 *
 * @param {object} [options]
 * @param {boolean} [options.harmonization=false] Also preload the AI-coloring model.
 * @param {(state: ProgressState) => void} [options.onProgress]
 * @param {(state: ProgressState) => void} [options.progress] Alias.
 * @param {RmbgAssets} [options.assets]
 * @param {boolean|'auto'} [options.threads]
 * @returns {Promise<{useSimd:boolean,useThreads:boolean,stages:string[]}>}
 */
export function load(options = {}) {
  const { assets, key, threads } = resolveAssets(options);
  return exclusive(() => withReporter('load', options, async () => {
    const info = await ensureWorker(assets, key, threads);
    const stages = ['wasm', 'model'];
    if (options.harmonization) {
      await preloadHarmonization();
      stages.push('harmonization');
    }
    return Object.assign({}, info, { stages });
  }));
}

/** Terminate the worker and release all resources. */
export function dispose() {
  teardown();
}

/** Whether the runtime can run in the current environment. */
export function isSupported() {
  try {
    return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof Blob !== 'undefined';
  } catch (e) {
    return false;
  }
}

export default { removeBackground, colorize, harmonize, edgeEnhance, batch, load, dispose, isSupported, DEFAULT_ASSETS };
