/**
 * The worker body. It is written as a normal function and later stringified
 * (see `workerSource`) so the package needs no build step and no separate
 * worker asset: the main module creates a Blob worker from this source.
 *
 * The function must be completely self-contained: only browser/worker globals
 * (`self`, `location`, `importScripts`, `fetch`, `WebAssembly`, typed arrays)
 * may be referenced. Everything else arrives through a `config` message.
 *
 * Protocol (main -> worker)
 *   { cmd: 'config', glue, glueThreaded, pthreadWorker, wasm, wasmSimd,
 *     wasmThreads, wasmSimdThreads, model, harm?, threads?,
 *     modelData?, harmModelData? }
 *   { cmd: 'predict',     width, height, data: ArrayBuffer(RGBA) }
 *   { cmd: 'colorize',    width, height, imgData, maskImgData }   // ArrayBuffers(RGBA)
 *   { cmd: 'edgeEnhance', width, height, imgData, maskImgData }
 *   { cmd: 'preload' }                                            // warm up optional resources
 *   { cmd: 'close' }
 *
 * Protocol (worker -> main)
 *   { cmd: 'Init', useSimd, useThreads }                    runtime + RMBG model ready
 *   { cmd: 'loadProgress', stage, loaded, total }           resource download progress
 *   { cmd: 'preloaded', useSimd, useThreads }               optional resources warmed up
 *   { cmd: 'progressCB', val, maxVal }                      RMBG inference progress
 *   { cmd: 'result', op, width, height, data: ArrayBuffer } RGBA result
 *   { cmd: 'error', msg, code }
 */
function rmbgWorker() {
  'use strict';

  // Validation modules for the two wasm builds: detect SIMD opcodes and
  // shared-memory/atomics support respectively.
  var SIMD_TEST = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
    10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
  ]);
  var THREADS_TEST = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
    5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11
  ]);

  var mod = null;          // the Emscripten module object
  var model = null;        // Embind `Rmbg` instance  (remove background)
  var ssam = null;         // Embind `SSAM` instance  (AI coloring / harmonization)
  var ssamPromise = null;  // lazy init promise for `ssam`
  var progressFn = 0;      // addFunction pointer for the progress callback
  var lastPct = -1;
  var ready = false;
  var queue = [];
  var cfg = null;
  var usedSimd = false;
  var usedThreads = false;

  function hasSimd() {
    try { return WebAssembly.validate(SIMD_TEST); } catch (e) { return false; }
  }

  function hasThreads() {
    try {
      var isolated = false;
      try { isolated = crossOriginIsolated === true; } catch (e) { isolated = false; }
      return isolated && typeof SharedArrayBuffer !== 'undefined' && WebAssembly.validate(THREADS_TEST);
    } catch (e) { return false; }
  }

  function post(msg, transfer) {
    if (transfer) self.postMessage(msg, transfer);
    else self.postMessage(msg);
  }

  function fail(msg, code) {
    post({ cmd: 'error', msg: String(msg && msg.message || msg), code: code == null ? -1 : code });
  }

  function onProgress(val) {
    if (val > lastPct) { lastPct = val; post({ cmd: 'progressCB', val: val, maxVal: 1657 }); }
  }

  self.onmessage = function (ev) {
    var d = ev.data;
    if (!d) return;
    if (d.cmd === 'config') { boot(d); return; }
    if (!ready) { queue.push(d); return; }
    dispatch(d);
  };

  function boot(c) {
    cfg = c;
    usedSimd = hasSimd();
    // Multi-threaded builds need crossOriginIsolated + SharedArrayBuffer.
    usedThreads = !!(c.threads && c.glueThreaded && c.pthreadWorker && hasThreads());

    var wasmUrl, glueUrl;
    if (usedThreads) {
      wasmUrl = (usedSimd && c.wasmSimdThreads) ? c.wasmSimdThreads : c.wasmThreads;
      glueUrl = c.glueThreaded;
    } else {
      wasmUrl = (usedSimd && c.wasmSimd) ? c.wasmSimd : c.wasm;
      glueUrl = c.glue;
    }

    mod = {};
    // Keep the Emscripten glue away from its own `self.location` based
    // resolution: give it an absolute URL, and prefer an in-memory binary.
    mod.WasmFileUrl = wasmUrl;
    mod.locateFile = function () { return wasmUrl; };
    mod.onRuntimeInitialized = onRuntimeInitialized;
    if (usedThreads) {
      // Read by the pthread machinery: the script each pthread imports, and the
      // worker script used to spawn the pool.
      mod.WasmMainScript = c.glueThreaded;
      mod.WasmThreadsWorker = c.pthreadWorker;
    }
    location.rmbgModule = mod;

    var start = (c.wasmBinary && c.wasmBinary.byteLength)
      ? Promise.resolve(c.wasmBinary)
      : fetchArrayBuffer(wasmUrl, 'wasm', 'wasm');

    start.then(function (bytes) {
      mod.wasmBinary = bytes;
      // The glue reads `location.rmbgModule` and populates the same object.
      importScripts(glueUrl);
    }).catch(function (e) { fail('Failed to initialise runtime: ' + e); });
  }

  function onRuntimeInitialized() {
    try {
      model = new mod.Rmbg();
    } catch (e) { fail('Failed to create Rmbg instance: ' + e); return; }

    loadModel().then(function (buf) {
      setParams(model, buf);
      progressFn = mod.addFunction(onProgress, 'vi');
      model.setProgressCallback(progressFn);
      ready = true;
      post({ cmd: 'Init', useSimd: usedSimd, useThreads: usedThreads });
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) dispatch(q[i]);
    }).catch(function (e) { fail('Failed to load model: ' + e); });
  }

  function loadModel() {
    if (cfg.modelData && cfg.modelData.byteLength) return Promise.resolve(cfg.modelData);
    if (!cfg.model) return Promise.reject(new Error('no model url or modelData provided'));
    return fetchArrayBuffer(cfg.model, 'model', 'model');
  }

  function loadHarmModel() {
    if (cfg.harmModelData && cfg.harmModelData.byteLength) return Promise.resolve(cfg.harmModelData);
    if (!cfg.harmModel) return Promise.reject(new Error('no harmonization model url or harmModelData provided'));
    return fetchArrayBuffer(cfg.harmModel, 'harmonization model', 'harmonization');
  }

  // Streams the response so the main thread can render download progress.
  function fetchArrayBuffer(url, what, stage) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('failed to load ' + what + ': ' + r.status + ' ' + url);
      var total = 0;
      try { total = +(r.headers.get('content-length') || 0); } catch (e) { total = 0; }
      if (!r.body || typeof r.body.getReader !== 'function') return r.arrayBuffer();
      var reader = r.body.getReader();
      var received = 0;
      var chunks = [];
      post({ cmd: 'loadProgress', stage: stage, loaded: 0, total: total });
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var out = new Uint8Array(received);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
            post({ cmd: 'loadProgress', stage: stage, loaded: received, total: received });
            return out.buffer;
          }
          chunks.push(res.value);
          received += res.value.length;
          post({ cmd: 'loadProgress', stage: stage, loaded: received, total: total || received });
          return pump();
        });
      }
      return pump();
    });
  }

  function setParams(inst, buf) {
    var u8 = new Uint8Array(buf);
    var ptr = mod.__malloc(u8.length);
    mod.HEAPU8.set(u8, ptr);
    inst.setParams(ptr, u8.length);
  }

  function ensureSsam() {
    if (ssam) return Promise.resolve();
    if (!ssamPromise) {
      ssamPromise = loadHarmModel().then(function (buf) {
        ssam = new mod.SSAM();
        setParams(ssam, buf);
      }).catch(function (e) { ssamPromise = null; throw e; });
    }
    return ssamPromise;
  }

  function dispatch(d) {
    try {
      if (d.cmd === 'predict') { predict(d); return; }
      if (d.cmd === 'colorize') { colorize(d); return; }
      if (d.cmd === 'edgeEnhance') { edgeEnhance(d); return; }
      if (d.cmd === 'preload') { preload(); return; }
      if (d.cmd === 'close') { try { self.close(); } catch (e) {} return; }
      fail('unknown command: ' + d.cmd);
    } catch (e) { fail(e); }
  }

  // Warms up an optional resource (the harmonization model) so a later
  // `colorize` call does not pay the download cost. Emits the same
  // `loadProgress` messages as the built-in initialization.
  function preload() {
    ensureSsam().then(function () {
      post({ cmd: 'preloaded', useSimd: usedSimd, useThreads: usedThreads });
    }).catch(function (e) { fail(e); });
  }

  function alloc(bytes) {
    var ptr = mod.__malloc(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  function read(ptr, width, height) {
    var out = mod.HEAPU8.subarray(ptr, ptr + width * height * 4).slice();
    mod.__free(ptr);
    return out;
  }

  function emit(op, width, height, bytes) {
    post({ cmd: 'result', op: op, width: width, height: height, data: bytes.buffer }, [bytes.buffer]);
  }

  function predict(d) {
    lastPct = -1; // reset per-call progress tracking (was previously only reported once)
    var ptr = alloc(new Uint8Array(d.data));
    var out = model.predict(ptr, ptr, d.width, d.height);
    var bytes = read(ptr, out.width, out.height);
    emit('predict', out.width, out.height, bytes);
  }

  function colorize(d) {
    ensureSsam().then(function () {
      var imgPtr = alloc(new Uint8Array(d.imgData));
      var maskPtr = alloc(new Uint8Array(d.maskImgData));
      ssam.predict(imgPtr, maskPtr, imgPtr, d.width, d.height);
      var bytes = mod.HEAPU8.subarray(imgPtr, imgPtr + d.width * d.height * 4).slice();
      mod.__free(imgPtr);
      mod.__free(maskPtr);
      emit('colorize', d.width, d.height, bytes);
    }).catch(function (e) { fail(e); });
  }

  function edgeEnhance(d) {
    var imgPtr = alloc(new Uint8Array(d.imgData));
    var maskPtr = alloc(new Uint8Array(d.maskImgData));
    mod._EgdeEnhance(imgPtr, maskPtr, imgPtr, d.width, d.height);
    var bytes = mod.HEAPU8.subarray(imgPtr, imgPtr + d.width * d.height * 4).slice();
    mod.__free(imgPtr);
    mod.__free(maskPtr);
    emit('edgeEnhance', d.width, d.height, bytes);
  }
}

/** Source text for `new Worker(URL.createObjectURL(new Blob([workerSource])))`. */
export const workerSource = '(' + rmbgWorker.toString() + ')();';
