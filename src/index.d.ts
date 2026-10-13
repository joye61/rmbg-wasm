export type OutputFormat =
  | 'blob'
  | 'imageData'
  | 'arrayBuffer'
  | 'uint8array'
  | 'bitmap'
  | 'canvas';

export interface RmbgAssets {
  /** Emscripten/Embind glue script URL (single-threaded). */
  glue?: string;
  /** Baseline (non-SIMD) wasm module URL. */
  wasm?: string;
  /** SIMD-accelerated wasm module URL. */
  wasmSimd?: string;
  /** Emscripten/Embind glue script URL (multi-threaded). */
  glueThreaded?: string;
  /** Pthread pool worker script URL (multi-threaded). */
  pthreadWorker?: string;
  /** Multi-threaded (non-SIMD) wasm module URL. */
  wasmThreads?: string;
  /** Multi-threaded SIMD wasm module URL. */
  wasmSimdThreads?: string;
  /** RMBG model parameter file URL. */
  model?: string;
  /** Harmonization ("AI Coloring") model parameter file URL. */
  harm?: string;
  /** Pre-loaded RMBG model bytes (skips the network download). */
  modelData?: ArrayBuffer;
  /** Pre-loaded harmonization model bytes. */
  harmModelData?: ArrayBuffer;
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type RmbgInput =
  | string
  | Blob
  | File
  | ArrayBuffer
  | ArrayBufferView
  | RgbaImage
  | ImageData
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/**
 * Progress state emitted to `onProgress` / `progress`. Data only — render it
 * however you like.
 */
export interface ProgressState {
  /** The operation producing this state. */
  op: 'removeBackground' | 'colorize' | 'edgeEnhance' | 'batch' | 'load';
  /** `'loading'` while fetching wasm/weights, `'processing'` during inference, `'done'` at the end. */
  phase: 'loading' | 'processing' | 'done';
  /** Loading source when `phase === 'loading'`. */
  stage?: 'wasm' | 'model' | 'harmonization';
  /** Phase-local numerator (bytes while loading, model steps while processing). */
  value: number;
  /** Phase-local denominator. */
  max: number;
  /** Phase-local fraction `value / max` (0..1). */
  ratio: number;
  /** Position of the current resource in the preload plan (`phase === 'loading'`). */
  stageIndex?: number;
  /** Number of resources in the preload plan (`phase === 'loading'`). */
  stageCount?: number;
  /** Present for `batch`: zero-based index of the current item. */
  index?: number;
  /** Present for `batch`: number of items. */
  count?: number;
  /** Suggested human-readable label (e.g. `'Removing background'`). */
  label: string;
}

export interface RemoveBackgroundOptions {
  /** Result format. Defaults to `'blob'`. */
  output?: OutputFormat;
  /** Blob MIME type. Defaults to `'image/png'`. */
  type?: string;
  /** Blob quality for lossy types. */
  quality?: number;
  /** Progress callback. */
  onProgress?: (state: ProgressState) => void;
  /** Alias of `onProgress`. */
  progress?: (state: ProgressState) => void;
  /**
   * Refine the alpha at full resolution with a local, edge-aware guided filter
   * (a purely client-side "HD" pass). Pass an object to tune `radius` / `eps` /
   * `strength`. Defaults to `false` (raw model output).
   */
  hd?: boolean | { radius?: number; eps?: number; strength?: number };
  /**
   * Cap the long side of the image fed to the model. Larger images are
   * downscaled for inference and the matte is upscaled back to native
   * resolution. `0` (default) means "use the native resolution".
   */
  maxSize?: number;
  /** Abort the running inference and tear down the worker. */
  signal?: AbortSignal;
  /**
   * Use the multi-threaded wasm build when the environment allows it
   * (`crossOriginIsolated` + `SharedArrayBuffer`). Defaults to `'auto'`.
   */
  threads?: boolean | 'auto';
  /** Override asset locations (useful for bundlers / CDNs / self-hosting). */
  assets?: RmbgAssets;
}

export interface InitInfo {
  useSimd: boolean;
  useThreads: boolean;
}

export declare const DEFAULT_ASSETS: Required<
  Pick<
    RmbgAssets,
    'glue' | 'wasm' | 'wasmSimd' | 'glueThreaded' | 'pthreadWorker' | 'wasmThreads' | 'wasmSimdThreads' | 'model' | 'harm'
  >
>;

export declare function removeBackground(
  input: RmbgInput,
  options?: RemoveBackgroundOptions & { output?: 'imageData' }
): Promise<ImageData>;
export declare function removeBackground(
  input: RmbgInput,
  options: RemoveBackgroundOptions & { output: 'arrayBuffer' }
): Promise<ArrayBuffer>;
export declare function removeBackground(
  input: RmbgInput,
  options: RemoveBackgroundOptions & { output: 'uint8array' }
): Promise<Uint8Array>;
export declare function removeBackground(
  input: RmbgInput,
  options: RemoveBackgroundOptions & { output: 'bitmap' }
): Promise<ImageBitmap>;
export declare function removeBackground(
  input: RmbgInput,
  options: RemoveBackgroundOptions & { output: 'canvas' }
): Promise<OffscreenCanvas | HTMLCanvasElement>;
export declare function removeBackground(
  input: RmbgInput,
  options?: RemoveBackgroundOptions & { output?: 'blob' }
): Promise<Blob>;

/**
 * AI color harmonization ("AI Coloring"). `mask` is the subject cutout; when
 * omitted it is computed with `removeBackground(image)`.
 */
export declare function colorize(
  image: RmbgInput,
  mask?: RmbgInput,
  options?: RemoveBackgroundOptions
): Promise<Blob | ImageData | ArrayBuffer | Uint8Array | ImageBitmap | OffscreenCanvas | HTMLCanvasElement>;

/** Alias of `colorize`. */
export declare const harmonize: typeof colorize;

/**
 * Edge enhancement. `mask` is the subject cutout; when omitted it is computed
 * with `removeBackground(image)`.
 */
export declare function edgeEnhance(
  image: RmbgInput,
  mask?: RmbgInput,
  options?: RemoveBackgroundOptions
): Promise<Blob | ImageData | ArrayBuffer | Uint8Array | ImageBitmap | OffscreenCanvas | HTMLCanvasElement>;

export interface LoadOptions {
  /**
   * Also preload the AI-coloring (harmonization) model so the first `colorize`
   * call is fast. Defaults to `false`.
   */
  harmonization?: boolean;
  /** Detailed progress callback (per resource). */
  onProgress?: (state: ProgressState) => void;
  /** Alias of `onProgress`. */
  progress?: (state: ProgressState) => void;
  /** Override asset locations. */
  assets?: RmbgAssets;
  /** Use the multi-threaded build when available. Defaults to `'auto'`. */
  threads?: boolean | 'auto';
}

export interface LoadResult extends InitInfo {
  /** The resources that were loaded, in order (e.g. `['wasm', 'model']`). */
  stages: string[];
}

/** Preload runtime resources with detailed progress. */
export declare function load(options?: LoadOptions): Promise<LoadResult>;

export interface BatchResult<T> {
  ok: boolean;
  result?: T;
  error?: Error;
}

export interface BatchOptions extends RemoveBackgroundOptions {
  op?: 'removeBackground' | 'colorize' | 'edgeEnhance';
  continueOnError?: boolean;
}

/** Process many items sequentially with the chosen operation. */
export declare function batch(
  items: RmbgInput[] | Array<{ image: RmbgInput; mask?: RmbgInput }> | Array<[RmbgInput, RmbgInput?]>,
  options?: BatchOptions
): Promise<Array<BatchResult<unknown>>>;

/** Terminate the worker and free resources. */
export declare function dispose(): void;

/** Whether the runtime can run in the current environment. */
export declare function isSupported(): boolean;

declare const _default: {
  removeBackground: typeof removeBackground;
  colorize: typeof colorize;
  harmonize: typeof harmonize;
  edgeEnhance: typeof edgeEnhance;
  batch: typeof batch;
  load: typeof load;
  dispose: typeof dispose;
  isSupported: typeof isSupported;
  DEFAULT_ASSETS: typeof DEFAULT_ASSETS;
};
export default _default;
