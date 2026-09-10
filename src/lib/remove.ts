/**
 * The engine: everything that touches pixels or the model lives here, so the UI only ever
 * deals with Blobs and progress events. Runs in the browser only; import lazily from client code.
 *
 * Contract (the UI is written against these signatures; keep them stable):
 */

import type { Config } from "@imgly/background-removal";
import { LIMITS, MODEL_FILES } from "@/lib/config";

/** Which backend ONNX Runtime ended up on. */
export type Engine = "webgpu" | "wasm";

export type Progress =
  /** Model weights are being fetched (bytes). Only happens once per browser; cached after. */
  | { kind: "download"; loaded: number; total: number }
  /** The model is running on the image. */
  | { kind: "infer" }
  /** The cutout is being composed / encoded. */
  | { kind: "compose" };

export type RemoveResult = {
  /** PNG with alpha, same pixel size as the (possibly downscaled) input. */
  blob: Blob;
  width: number;
  height: number;
  /** Wall-clock milliseconds for inference + compose, excluding the model download. */
  ms: number;
  engine: Engine;
};

export type Backdrop = { kind: "transparent" } | { kind: "color"; hex: string } | { kind: "blur"; radius: number };

/* ------------------------------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------------------------------- */

/** Shown when the browser cannot decode a file (HEIC on iOS Safari, exotic AVIF, corrupt data). */
export const UNSUPPORTED_FORMAT_MESSAGE = "This format isn't supported by your browser. Try a JPEG or PNG.";

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/* ------------------------------------------------------------------------------------------------
 * Engine detection
 * ---------------------------------------------------------------------------------------------- */

/** The DOM lib does not ship WebGPU types; this is the sliver of the API we probe. */
type GpuNavigator = Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } };

let enginePromise: Promise<Engine> | undefined;

/**
 * Set once a `gpu` run has thrown. From then on every call goes straight to WebAssembly and
 * `detectEngine()` answers "wasm" so the UI footer stays truthful.
 */
let gpuFailed = false;

/** Probes WebGPU once and remembers the answer. Never throws. */
export function detectEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = probeWebGpu();
  }
  return enginePromise;
}

async function probeWebGpu(): Promise<Engine> {
  try {
    if (typeof navigator === "undefined") return "wasm";
    const gpu = (navigator as GpuNavigator).gpu;
    if (!gpu) return "wasm";
    const adapter = await gpu.requestAdapter();
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

function rememberGpuFailure(): void {
  gpuFailed = true;
  enginePromise = Promise.resolve("wasm");
}

/** The engine we will actually hand to the library right now. */
async function effectiveEngine(): Promise<Engine> {
  if (gpuFailed) return "wasm";
  return detectEngine();
}

/* ------------------------------------------------------------------------------------------------
 * Library plumbing
 * ---------------------------------------------------------------------------------------------- */

type RawProgress = (key: string, current: number, total: number) => void;

/**
 * The library memoises its session by `JSON.stringify(config)` and keeps using the `progress`
 * callback from the *first* call for every later one. So we hand it a single stable dispatcher and
 * fan events out to whoever is listening right now.
 */
const listeners = new Set<RawProgress>();

function dispatchProgress(key: string, current: number, total: number): void {
  for (const listener of listeners) listener(key, current, total);
}

/**
 * Bumped after a failed init. The library memoises `initInference` by `JSON.stringify(config)`
 * and caches the rejected promise too, so without a new key every retry after an offline first
 * run would get the same rejection back without touching the network. A successful, resident
 * session keeps its key.
 */
let attempt = 0;

function libraryConfig(engine: Engine): Config {
  return {
    device: engine === "webgpu" ? "gpu" : "cpu",
    model: engine === "webgpu" ? "isnet_fp16" : "isnet_quint8",
    // Only honoured on WebGPU: the library runs the WebAssembly session on the main thread, so
    // on that path the page pauses for the length of the inference. The UI says so.
    proxyToWorker: true,
    output: { format: "image/png" },
    progress: dispatchProgress,
    // Part of the memoise key (see `attempt`); fetch() ignores unknown options.
    fetchArgs: { attempt },
  };
}

/** `lib.preload` that makes the next try a real one when this one fails. */
async function initLibrary(lib: Library, config: Config): Promise<void> {
  try {
    await lib.preload(config);
  } catch (error) {
    attempt++;
    throw error;
  }
}

/**
 * Whether an error is the network failing (offline, a CDN 5xx, a truncated chunk) rather than
 * the backend: those must not send WebGPU machines to the WebAssembly fallback. The library
 * wraps backend failures as "Failed to create session: ..." and raises fetch problems raw.
 */
function isTransferError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (/create session/i.test(msg)) return false;
  return error instanceof TypeError || /Failed to fetch|Resource .*not found|Load failed|NetworkError/i.test(msg);
}

/**
 * Turns the library's raw `(key, current, total)` stream into our `Progress` events.
 *
 * Downloads arrive per file (`fetch:/models/isnet_fp16`, `fetch:/onnxruntime-web/...wasm`, ...),
 * one after another and each with its own total. The map is seeded with the engine's known
 * file set so the total is right from the first event instead of growing as files show up
 * (which made the bar hit 100% and drop back); anything unexpected is added when it appears.
 */
function makeProgressMapper(engine: Engine, onProgress?: (p: Progress) => void): RawProgress {
  const files = new Map(Object.entries(MODEL_FILES[engine]).map(([key, total]) => [`fetch:${key}`, { loaded: 0, total }]));
  return (key, current, total) => {
    if (key.startsWith("fetch:")) {
      files.set(key, { loaded: current, total });
      let loaded = 0;
      let sum = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        sum += f.total;
      }
      onProgress?.({ kind: "download", loaded, total: sum });
      return;
    }
    if (key.startsWith("compute:")) {
      onProgress?.(key === "compute:encode" ? { kind: "compose" } : { kind: "infer" });
    }
  };
}

type Library = typeof import("@imgly/background-removal");

function loadLibrary(): Promise<Library> {
  return import("@imgly/background-removal");
}

/** Settles like `work`, unless the signal fires first, in which case it rejects with AbortError. */
function withAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Fetches and warms the model so the first image doesn't pay for it. Safe to call many times. */
export async function preloadModel(onProgress?: (p: Progress) => void): Promise<void> {
  const lib = await loadLibrary();
  const engine = await effectiveEngine();
  const raw = makeProgressMapper(engine, onProgress);
  listeners.add(raw);
  try {
    try {
      await initLibrary(lib, libraryConfig(engine));
    } catch (error) {
      if (engine !== "webgpu" || isTransferError(error)) throw error;
      rememberGpuFailure();
      await initLibrary(lib, libraryConfig("wasm"));
    }
  } finally {
    listeners.delete(raw);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Pixels
 * ---------------------------------------------------------------------------------------------- */

/** The subset of the 2D context both `OffscreenCanvas` and `<canvas>` share and that we use. */
type Ctx = CanvasDrawImage & CanvasRect & CanvasFillStrokeStyles & CanvasFilters & CanvasImageSmoothing & CanvasState;

type Surface = { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx };

function makeSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  if (typeof document === "undefined") {
    throw new Error("Canvas is not available in this environment.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context.");
  return { canvas, ctx };
}

function toPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the image as PNG."));
    }, "image/png");
  });
}

/** Decodes a Blob to a bitmap, honouring EXIF orientation. Rejects with the friendly message. */
async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
  }
}

/** Decodes, downscales when needed, and reports the resulting pixel size. Closes its bitmap. */
async function fit(file: Blob, maxEdge: number): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await decode(file);
  try {
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { blob: file, width, height };

    const scale = maxEdge / longest;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const { canvas, ctx } = makeSurface(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { blob: await toPng(canvas), width: w, height: h };
  } finally {
    bitmap.close();
  }
}

/**
 * Reads pixel dimensions. Rejects with a friendly Error when the browser can't decode the format.
 * The queue reads size from its thumbnail decode instead; kept for callers that only need this.
 */
export async function loadImageMeta(file: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await decode(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/**
 * Re-encodes to PNG when the longest edge exceeds maxEdge; returns the same Blob otherwise.
 * `removeBackground` does this itself, so only call it when the fitted Blob is needed on its own.
 */
export async function downscaleIfNeeded(file: Blob, maxEdge: number): Promise<Blob> {
  const { blob } = await fit(file, maxEdge);
  return blob;
}

/* ------------------------------------------------------------------------------------------------
 * Removal
 * ---------------------------------------------------------------------------------------------- */

/**
 * Removes the background. Downloads the model on first use (reported through onProgress), runs
 * WebGPU when available and falls back to WebAssembly once if WebGPU fails. Rejects with
 * DOMException "AbortError" when the signal fires.
 */
export async function removeBackground(
  file: Blob,
  opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void },
): Promise<RemoveResult> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError();

  const lib = await loadLibrary();
  const input = await fit(file, LIMITS.maxEdge);
  if (signal?.aborted) throw abortError();

  const engine = await effectiveEngine();
  try {
    return await runOnce(lib, engine, input, opts);
  } catch (error) {
    if (engine !== "webgpu" || signal?.aborted || isAbort(error) || isTransferError(error)) throw error;
    // WebGPU init or inference blew up: remember it and give WebAssembly one go on this image.
    rememberGpuFailure();
    return runOnce(lib, "wasm", input, opts);
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function runOnce(
  lib: Library,
  engine: Engine,
  input: { blob: Blob; width: number; height: number },
  opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void },
): Promise<RemoveResult> {
  const signal = opts?.signal;
  const config = libraryConfig(engine);
  const raw = makeProgressMapper(engine, opts?.onProgress);
  listeners.add(raw);
  try {
    await withAbort(initLibrary(lib, config), signal);

    // The library cannot cancel a running job, so on abort we let it finish in the background and
    // simply refuse to hand the result over. The swallowed catch avoids an unhandled rejection.
    // The clock starts after preload so the download is excluded and an abandoned job's leftover
    // progress events (the listeners are shared) cannot inflate it.
    const t0 = performance.now();
    const work = lib.removeBackground(input.blob, config);
    work.catch(() => {});
    const blob = await withAbort(work, signal);
    if (signal?.aborted) throw abortError();

    const ms = performance.now() - t0;
    return { blob, width: input.width, height: input.height, ms, engine };
  } finally {
    listeners.delete(raw);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Compose
 * ---------------------------------------------------------------------------------------------- */

/** Paints the cutout over the chosen backdrop (transparent, a flat colour, or the blurred original) and returns a PNG. */
export async function composeBackdrop(cutout: Blob, original: Blob, backdrop: Backdrop): Promise<Blob> {
  const fg = await decode(cutout);
  try {
    const { width, height } = fg;
    const { canvas, ctx } = makeSurface(width, height);

    if (backdrop.kind === "color") {
      ctx.fillStyle = backdrop.hex;
      ctx.fillRect(0, 0, width, height);
    } else if (backdrop.kind === "blur") {
      const bg = await decode(original);
      try {
        drawBlurred(ctx, bg, width, height, backdrop.radius);
      } finally {
        bg.close();
      }
    }

    ctx.drawImage(fg, 0, 0, width, height);
    return await toPng(canvas);
  } finally {
    fg.close();
  }
}

/**
 * Draws `source` blurred to fill a `width`x`height` canvas. Blur samples past the image edge into
 * transparency, so we overdraw by a margin larger than the blur reach; the fringe lands off-canvas.
 * Browsers without `ctx.filter` (older Safari) get a cheap approximation: shrink, then stretch back
 * with bilinear smoothing.
 */
function drawBlurred(ctx: Ctx, source: ImageBitmap, width: number, height: number, radius: number): void {
  const r = Math.max(0, radius);
  const pad = Math.ceil(r * 3);

  ctx.save();
  const filter = `blur(${r}px)`;
  ctx.filter = filter;
  // Browsers without filter support leave the property untouched (or undefined), so read it back.
  const supportsFilter = r === 0 || ctx.filter === filter;
  if (supportsFilter) {
    ctx.drawImage(source, -pad, -pad, width + pad * 2, height + pad * 2);
    ctx.restore();
    return;
  }
  ctx.restore();

  // Fallback: a box-ish blur by resampling. Each halving roughly doubles the softness.
  const shrink = Math.max(1, Math.round(r / 2));
  const sw = Math.max(1, Math.round(width / shrink));
  const sh = Math.max(1, Math.round(height / shrink));
  const small = makeSurface(sw, sh);
  small.ctx.imageSmoothingEnabled = true;
  small.ctx.imageSmoothingQuality = "high";
  small.ctx.drawImage(source, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small.canvas, -pad, -pad, width + pad * 2, height + pad * 2);
}
