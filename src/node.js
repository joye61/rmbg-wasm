/**
 * Node.js entry point (raw RGBA in / raw RGBA out).
 *
 * Node has no canvas, so this entry works with plain RGBA buffers:
 *   const { data, width, height } = await removeBackground({ data, width, height });
 *   const colored = await colorize({ data, width, height }, mask);
 *   const edged = await edgeEnhance({ data, width, height }, mask);
 *
 * The same shipped wasm + models are executed on the main thread inside an
 * isolated VM context that emulates the Emscripten Node environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { guidedFilterAlpha, resizeRgba, resizeFloat01 } from './refine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '../assets');

export const DEFAULT_ASSETS = {
  glue: path.join(ASSETS_DIR, 'rmbg.glue.js'),
  wasm: path.join(ASSETS_DIR, 'rmbg.wasm'),
  wasmSimd: path.join(ASSETS_DIR, 'rmbg.simd.wasm'),
  model: path.join(ASSETS_DIR, 'rmbg.model.tf'),
  harm: path.join(ASSETS_DIR, 'rmbg.harm.tf'),
};

const SIMD_TEST = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
]);

function toPath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (typeof value === 'string' && value.startsWith('file:')) return fileURLToPath(value);
  return value;
}

function hasSimd() {
  try { return WebAssembly.validate(SIMD_TEST); } catch (e) { return false; }
}

let instance = null;
let chain = Promise.resolve();
let activeReporter = null;
let activeOp = null;

const OP_LABELS = {
  removeBackground: 'Removing background',
  colorize: 'Coloring',
  edgeEnhance: 'Enhancing edges',
  batch: 'Processing',
  load: 'Loading model',
};

function progressCallbackOf(options) {
  if (!options) return null;
  const fn = typeof options.onProgress === 'function' ? options.onProgress
    : (typeof options.progress === 'function' ? options.progress : null);
  return fn;
}

function createReporter(options, op) {
  if (options && options._progressReporter) {
    const outer = options._progressReporter;
    return { emit: (state) => outer.emit(state) };
  }
  const fn = progressCallbackOf(options);
  return {
    emit(state) {
      if (!fn) return;
      try { fn(state); } catch (e) { /* ignore */ }
    },
  };
}

function doneState(op) {
  return { op, phase: 'done', value: 1, max: 1, ratio: 1, label: 'Done' };
}

async function withReporter(op, options, task) {
  const reporter = createReporter(options, op);
  activeReporter = reporter;
  activeOp = op;
  try {
    const result = await task();
    reporter.emit(doneState(op));
    return result;
  } finally {
    activeReporter = null;
    activeOp = null;
  }
}

function createInstance(assets) {
  const gluePath = toPath(assets.glue);
  const glueSource = fs.readFileSync(gluePath, 'utf8');
  const simd = hasSimd();
  const wasmPath = toPath(simd && assets.wasmSimd ? assets.wasmSimd : assets.wasm);
  const wasmBytes = fs.readFileSync(wasmPath);

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  const cfg = {
    WasmFileUrl: path.basename(wasmPath),
    locateFile: () => wasmPath,
    wasmBinary: wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
    onRuntimeInitialized: () => resolveReady(),
  };

  // The wasm heap and its result views live in this VM realm; keep `process`
  // usable for environment detection but stop the glue from stacking
  // process-wide listeners on every instance.
  const sandboxProcess = Object.create(process);
  sandboxProcess.on = () => sandboxProcess;
  sandboxProcess.once = () => sandboxProcess;
  sandboxProcess.addListener = () => sandboxProcess;

  const sandbox = {
    location: { rmbgModule: cfg },
    console,
    process: sandboxProcess,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Blob,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    // Align error constructors with the host realm so the Emscripten glue's
    // `instanceof TypeError/RangeError` checks around WebAssembly.Table.set()
    // behave as they do in a browser (otherwise addFunction never falls back).
    Error,
    TypeError,
    RangeError,
    require: createRequire(import.meta.url),
    __dirname: path.dirname(gluePath),
    __filename: gluePath,
    module: { exports: {} },
    exports: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(glueSource, sandbox, { filename: 'rmbg.glue.js' });

  // The glue writes its exports onto `location.rmbgModule`, i.e. `cfg`.
  const mod = cfg;
  const key = [gluePath, wasmPath, toPath(assets.model), toPath(assets.harm)].join('|');
  return { key, mod, ready, simd, ssam: null, ssamPromise: null };
}

function setParams(mod, inst, buf) {
  const ptr = mod.__malloc(buf.length);
  mod.HEAPU8.set(buf, ptr);
  inst.setParams(ptr, buf.length);
}

async function ensureInstance(assets) {
  const key = [toPath(assets.glue), toPath(assets.wasm), toPath(assets.wasmSimd), toPath(assets.model), toPath(assets.harm)].join('|');
  if (!instance || instance.key !== key) instance = createInstance(assets);
  await instance.ready;
  const { mod } = instance;
  if (!instance.model) {
    const modelBytes = fs.readFileSync(toPath(assets.model));
    instance.model = new mod.Rmbg();
    setParams(mod, instance.model, modelBytes);
    if (mod.addFunction) {
      try {
        instance.progressPtr = mod.addFunction((val) => {
          if (!activeReporter) return;
          const ratio = val / 1657;
          activeReporter.emit({
            op: activeOp,
            phase: 'processing',
            value: val,
            max: 1657,
            ratio,
            label: OP_LABELS[activeOp] || OP_LABELS.batch,
          });
        }, 'vi');
        instance.model.setProgressCallback(instance.progressPtr);
      } catch (e) { /* progress is best-effort */ }
    }
  }
  return instance;
}

function ensureSsam(inst, assets) {
  if (inst.ssam) return Promise.resolve();
  if (!inst.ssamPromise) {
    inst.ssamPromise = Promise.resolve().then(() => {
      const bytes = fs.readFileSync(toPath(assets.harm));
      inst.ssam = new inst.mod.SSAM();
      setParams(inst.mod, inst.ssam, bytes);
    }).catch((e) => { inst.ssamPromise = null; throw e; });
  }
  return inst.ssamPromise;
}

export function normalizeInput(input, options = {}) {
  if (input && typeof input === 'object' && input.data && input.width && input.height) {
    const data = input.data instanceof Uint8ClampedArray ? input.data : new Uint8ClampedArray(input.data.buffer || input.data);
    return { data, width: input.width, height: input.height };
  }
  if ((input instanceof Uint8Array || input instanceof Uint8ClampedArray || Buffer.isBuffer(input)) && options.width && options.height) {
    const data = input instanceof Uint8ClampedArray ? input : new Uint8ClampedArray(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    return { data, width: options.width, height: options.height };
  }
  throw new TypeError('Node input must be { data, width, height } RGBA or a typed array with options.width/options.height');
}

function alloc(mod, rgba) {
  const ptr = mod.__malloc(rgba.length);
  mod.HEAPU8.set(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), ptr);
  return ptr;
}

function exclusive(task) {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function outFormat(data, width, height, output) {
  // The wasm heap lives in a separate VM realm, so its typed arrays fail
  // `instanceof` checks in the host. Copy into host-realm buffers.
  const bytes = new Uint8Array(data.length);
  bytes.set(data);
  if (output === 'arrayBuffer') return bytes.buffer;
  if (output === 'uint8array') return bytes;
  return { data: new Uint8ClampedArray(bytes.buffer), width, height };
}

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
  out.set(src.data.length === out.length ? src.data : src.data.subarray(0, out.length));
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = Math.round(alpha[i] * 255);
  return { width, height, data: out };
}

/**
 * Remove the background. Input and output are raw RGBA.
 * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number}|Uint8Array} input
 * @param {object} [options]
 * @param {'rgba'|'uint8array'|'arrayBuffer'} [options.output='rgba']
 * @param {number} [options.maxSize] Cap the long side fed to the model.
 * @param {boolean|{radius?:number,eps?:number,strength?:number}} [options.hd]
 *   Refine the alpha at full resolution with an edge-aware guided filter.
 * @param {(state:object)=>void} [options.onProgress]
 * @param {{glue?:string,wasm?:string,wasmSimd?:string,model?:string,harm?:string}} [options.assets]
 */
export function removeBackground(input, options = {}) {
  const assets = Object.assign({}, DEFAULT_ASSETS, options.assets);
  const rgba = normalizeInput(input, options);
  return exclusive(() => withReporter('removeBackground', options, async () => {
    const inst = await ensureInstance(assets);
    const { mod } = inst;

    const maxSize = options.maxSize || 0;
    const longSide = Math.max(rgba.width, rgba.height);
    let modelInput = rgba;
    if (maxSize && longSide > maxSize) {
      const scale = maxSize / longSide;
      const w = Math.max(1, Math.round(rgba.width * scale));
      const h = Math.max(1, Math.round(rgba.height * scale));
      modelInput = { data: resizeRgba(rgba.data, rgba.width, rgba.height, w, h), width: w, height: h };
    }

    const ptr = alloc(mod, modelInput.data);
    const out = inst.model.predict(ptr, ptr, modelInput.width, modelInput.height);
    const width = out.width, height = out.height;
    const data = mod.HEAPU8.subarray(ptr, ptr + width * height * 4).slice();
    mod.__free(ptr);

    const hd = options.hd;
    const refineOptions = hd === true ? {} : (hd && typeof hd === 'object' ? hd : null);
    const resized = modelInput.width !== rgba.width || modelInput.height !== rgba.height;
    if (refineOptions || resized) {
      const composed = composeWithMatte(rgba, { data, width, height }, refineOptions);
      return outFormat(composed.data, composed.width, composed.height, options.output);
    }
    return outFormat(data, width, height, options.output);
  }));
}

function fitMask(mask, width, height) {
  if (mask.width === width && mask.height === height) return mask;
  // Simple nearest-neighbour resize via nearest sampling would need canvas; in
  // Node we require matching dimensions.
  throw new Error(`mask size ${mask.width}x${mask.height} must match image size ${width}x${height}`);
}

async function enhance(op, image, mask, options) {
  const assets = Object.assign({}, DEFAULT_ASSETS, options.assets);
  const img = normalizeInput(image, options);
  const reporter = createReporter(options, op);
  const maskInput = mask == null
    ? await removeBackground(img, {
        assets: options.assets,
        _progressReporter: { emit: (state) => { if (state.phase !== 'done') reporter.emit(state); } },
      })
    : normalizeInput(mask, options);
  const fitted = fitMask(maskInput, img.width, img.height);

  return exclusive(() => {
    activeReporter = reporter;
    activeOp = op;
    return (async () => {
      try {
        const inst = await ensureInstance(assets);
        reporter.emit({ op, phase: 'processing', value: 0, max: 1, ratio: 0, label: OP_LABELS[op] });
        const { mod } = inst;
        const imgPtr = alloc(mod, img.data);
        const maskPtr = alloc(mod, fitted.data);
        if (op === 'colorize') {
          await ensureSsam(inst, assets);
          inst.ssam.predict(imgPtr, maskPtr, imgPtr, img.width, img.height);
        } else {
          mod._EgdeEnhance(imgPtr, maskPtr, imgPtr, img.width, img.height);
        }
        const data = mod.HEAPU8.subarray(imgPtr, imgPtr + img.width * img.height * 4).slice();
        mod.__free(imgPtr);
        mod.__free(maskPtr);
        reporter.emit(doneState(op));
        return outFormat(data, img.width, img.height, options.output);
      } finally {
        activeReporter = null;
        activeOp = null;
      }
    })();
  });
}

/**
 * AI color harmonization. `image` and `mask` are raw RGBA.
 * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number}} image
 * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number}} [mask]
 * @param {object} [options]
 */
export function colorize(image, mask, options = {}) {
  return enhance('colorize', image, mask, options);
}

/** Alias of {@link colorize}. */
export const harmonize = colorize;

/**
 * Edge enhancement. `image` and `mask` are raw RGBA.
 * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number}} image
 * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number}} [mask]
 * @param {object} [options]
 */
export function edgeEnhance(image, mask, options = {}) {
  return enhance('edgeEnhance', image, mask, options);
}

/**
 * Process many raw-RGBA items sequentially.
 * @param {Array} items See `batch` in the browser entry.
 * @param {object} [options]
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
      else if (item && typeof item === 'object' && item.image && item.image.data) result = await target(item.image, item.mask, itemOptions);
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

/**
 * Preload the wasm module and RMBG model. Pass `harmonization: true` to also
 * load the AI-coloring model. In Node the resources are read from disk, so
 * progress is coarse (no byte-level download events).
 * @returns {Promise<{useSimd:boolean,useThreads:boolean,stages:string[]}>}
 */
export function load(options = {}) {
  const assets = Object.assign({}, DEFAULT_ASSETS, options.assets);
  return exclusive(() => withReporter('load', options, async () => {
    const inst = await ensureInstance(assets);
    const stages = ['wasm', 'model'];
    if (options.harmonization) {
      await ensureSsam(inst, assets);
      stages.push('harmonization');
    }
    return { useSimd: inst.simd, useThreads: false, stages };
  }));
}

/** Release the cached instance. */
export function dispose() {
  instance = null;
}

export function isSupported() {
  return typeof WebAssembly !== 'undefined';
}

export default { removeBackground, colorize, harmonize, edgeEnhance, batch, load, dispose, isSupported, DEFAULT_ASSETS };
