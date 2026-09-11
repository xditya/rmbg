/**
 * The engine: everything that touches pixels or the model lives here, so the UI only ever
 * deals with Blobs and progress events. Runs in the browser only; import lazily from client code.
 *
 * Contract (the UI is written against these signatures; keep them stable):
 */

import type { Config } from "@imgly/background-removal";
import { GPU_FRAME_PATH, MODEL_BASE_URL, MODEL_CACHE_NAME, MODEL_FILES, type ModelStatus } from "@/lib/config";
import { decodeFull, decodeScaled, loadImageMeta, UNSUPPORTED_FORMAT_MESSAGE } from "@/lib/decode";
import { maskLooksSane } from "@/lib/mask-check";
import { maxEdge } from "@/lib/memory";
import { modelCacheReady, requestPersistentStorage } from "@/lib/model-cache";

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

export { loadImageMeta, UNSUPPORTED_FORMAT_MESSAGE };

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/* ------------------------------------------------------------------------------------------------
 * Engine detection
 * ---------------------------------------------------------------------------------------------- */

/** The DOM lib does not ship WebGPU types; this is the sliver of the API we probe. */
type GpuAdapter = { features: { has(name: string): boolean } };
type GpuNavigator = Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } };

let enginePromise: Promise<Engine> | undefined;

/** Why WebGPU was given up on: it threw, or its self-check came back with a wrong mask. */
export type GpuFallbackReason = "error" | "wrong-result";

/**
 * Set once a `gpu` run has thrown or failed its self-check. From then on every call goes
 * straight to WebAssembly and `detectEngine()` answers "wasm" so the UI footer stays truthful.
 */
let gpuFailure: GpuFallbackReason | null = null;

/** Probes WebGPU once and remembers the answer. Never throws. */
export function detectEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = probeWebGpu();
  }
  return enginePromise;
}

/**
 * WebGPU only counts when the adapter has f16 shaders: the WebGPU build runs the fp16 model,
 * and ONNX Runtime runs it on an adapter without the feature anyway, returning garbage (an
 * all-transparent cutout on Chromium's software adapter, wrong edges on some drivers).
 */
async function probeWebGpu(): Promise<Engine> {
  try {
    if (typeof navigator === "undefined") return "wasm";
    const gpu = (navigator as GpuNavigator).gpu;
    if (!gpu) return "wasm";
    const adapter = await gpu.requestAdapter();
    return adapter?.features?.has("shader-f16") ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/**
 * The first reason wins: a later "error" must not hide that the self-check was what failed.
 * The frame goes with it: its session would never be used again, and it holds the weights.
 */
function rememberGpuFailure(reason: GpuFallbackReason): void {
  gpuFailure ??= reason;
  enginePromise = Promise.resolve("wasm");
  closeGpuFrame();
}

/** Why the session left WebGPU, or null while it has not. Lets the UI word its notice. */
export function gpuFallbackReason(): GpuFallbackReason | null {
  return gpuFailure;
}

/* ------------------------------------------------------------------------------------------------
 * Engine preference
 * ---------------------------------------------------------------------------------------------- */

/** "auto" lets detection decide; "wasm" skips WebGPU for every job. */
export type EnginePreference = "auto" | "wasm";

/** localStorage key of the preference; `?engine=wasm` in the URL overrides it for one visit. */
export const ENGINE_PREFERENCE_KEY = "rmbg:engine";

let preference: EnginePreference | undefined;

function readPreference(): EnginePreference {
  if (typeof window === "undefined") return "auto";
  try {
    const query = new URLSearchParams(window.location.search).get("engine");
    if (query === "wasm" || query === "auto") return query;
    if (window.localStorage.getItem(ENGINE_PREFERENCE_KEY) === "wasm") return "wasm";
  } catch {
    /* no storage (private mode, blocked): the default */
  }
  return "auto";
}

/** Read once per session: the URL first, then localStorage, else "auto". */
export function getEnginePreference(): EnginePreference {
  preference ??= readPreference();
  return preference;
}

const preferenceListeners = new Set<() => void>();

/** Persists the choice and applies it to the next job; a running one is left alone. */
export function setEnginePreference(next: EnginePreference): void {
  preference = next;
  try {
    window.localStorage.setItem(ENGINE_PREFERENCE_KEY, next);
  } catch {
    /* the choice still holds for this visit */
  }
  for (const listener of preferenceListeners) listener();
}

/** For `useSyncExternalStore`: called after every `setEnginePreference`. */
export function subscribeEnginePreference(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}

/** The engine the next job will actually run on: the preference, then the failure memory, then detection. */
export async function resolveEngine(): Promise<Engine> {
  if (getEnginePreference() === "wasm" || gpuFailure) return "wasm";
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

/** Subscribes to the library's raw progress stream (the frame relays it to the page); returns the unsubscribe. */
export function onRawProgress(listener: RawProgress): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Bumped after a failed init. The library memoises `initInference` by `JSON.stringify(config)`
 * and caches the rejected promise too, so without a new key every retry after an offline first
 * run would get the same rejection back without touching the network. A successful, resident
 * session keeps its key.
 */
let attempt = 0;

export function libraryConfig(engine: Engine): Config {
  return {
    // The CDN or the mirror `NEXT_PUBLIC_MODEL_URL` names; the service worker caches what comes from here.
    publicPath: MODEL_BASE_URL,
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

/** `lib.preload` that makes the next try a real one when this one fails. Waits for the model cache to take the page first. */
export async function initLibrary(lib: Library, config: Config): Promise<void> {
  await modelCacheReady();
  try {
    await lib.preload(config);
  } catch (error) {
    attempt++;
    throw error;
  }
  notifyModelLoaded(config.device === "gpu" ? "webgpu" : "wasm");
}

/* ------------------------------------------------------------------------------------------------
 * The model on the device
 * ---------------------------------------------------------------------------------------------- */

const loadedListeners = new Set<() => void>();

/** Called the first time each engine's model comes up, on the page or relayed from the frame: the picker's badges refresh. */
export function subscribeModelLoaded(listener: () => void): () => void {
  loadedListeners.add(listener);
  return () => {
    loadedListeners.delete(listener);
  };
}

/** The engines whose model has come up in this document. `initLibrary` runs on every WebAssembly job; the badges only need to hear once. */
const notified = new Set<Engine>();

/** A model is resident: ask the browser to keep the cache, and tell whoever shows the badges. Once per engine. */
function notifyModelLoaded(engine: Engine): void {
  if (notified.has(engine)) return;
  notified.add(engine);
  requestPersistentStorage();
  for (const listener of loadedListeners) listener();
}

type Manifest = Record<string, { chunks?: { name: string }[] } | undefined>;

const MANIFEST_URL = `${MODEL_BASE_URL}resources.json`;

let manifestFetch: Promise<Manifest | null> | undefined;

/**
 * The manifest, from the worker's cache first: the library fetched it through the worker
 * before any chunk, so once anything is downloaded the badges never contact the CDN. Before
 * that it is fetched once per document (through the worker, which keeps it); null when it
 * cannot be read, and the next call tries again.
 */
async function readManifest(cache: Cache): Promise<Manifest | null> {
  const cached = await cache.match(MANIFEST_URL);
  if (cached) return (await cached.json()) as Manifest;
  manifestFetch ??= fetch(MANIFEST_URL)
    .then((response) => (response.ok ? (response.json() as Promise<Manifest>) : null))
    .catch(() => null);
  const manifest = await manifestFetch;
  if (!manifest) manifestFetch = undefined;
  return manifest;
}

export type ModelStatuses = Record<Engine, ModelStatus>;

const UNKNOWN_STATUSES: ModelStatuses = { webgpu: "unknown", wasm: "unknown" };

let statusesInFlight: Promise<ModelStatuses> | undefined;

/**
 * Whether every file each engine needs (its model and its build of the runtime, the keys of
 * `MODEL_FILES`) is in the service worker's cache. One manifest read serves both engines,
 * and callers that ask at the same time (the two pickers of the desktop layout) share one
 * pass over the cache. "unknown" when the Cache API is missing (an insecure origin, an old
 * browser) or the manifest cannot be read.
 */
export function modelStatuses(): Promise<ModelStatuses> {
  if (typeof caches === "undefined") return Promise.resolve(UNKNOWN_STATUSES);
  statusesInFlight ??= (async () => {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const manifest = await readManifest(cache);
      if (!manifest) return UNKNOWN_STATUSES;
      const status = async (engine: Engine): Promise<ModelStatus> => {
        for (const key of Object.keys(MODEL_FILES[engine])) {
          const chunks = manifest[key]?.chunks;
          if (!chunks?.length) return "unknown";
          for (const chunk of chunks) {
            if (!(await cache.match(`${MODEL_BASE_URL}${chunk.name}`))) return "missing";
          }
        }
        return "downloaded";
      };
      return { webgpu: await status("webgpu"), wasm: await status("wasm") };
    } catch {
      return UNKNOWN_STATUSES;
    } finally {
      statusesInFlight = undefined;
    }
  })();
  return statusesInFlight;
}

/** One engine's entry of `modelStatuses`. */
export async function modelStatus(engine: Engine): Promise<ModelStatus> {
  return (await modelStatuses())[engine];
}

/**
 * Whether an error is the network failing (offline, a CDN 5xx, a truncated chunk) rather than
 * the backend: those must not send WebGPU machines to the WebAssembly fallback. The library
 * wraps backend failures as "Failed to create session: ..." and raises fetch problems raw.
 */
export function isTransferError(error: unknown): boolean {
  if (error instanceof GpuFrameError) return error.transfer;
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

export type Library = typeof import("@imgly/background-removal");

export function loadLibrary(): Promise<Library> {
  return import("@imgly/background-removal");
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` once every earlier run has settled. ORT's WebGPU session refuses overlapping runs
 * ("Session already started") and the library cannot cancel, so an abandoned job must finish
 * before the next card's may start; otherwise the two answers cross over in the proxy worker
 * and the next card gets the wrong mask or a spurious failure.
 */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => {});
  return next;
}

/** Settles like `work`, unless the signal fires first, in which case it rejects with AbortError. */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

/**
 * Fetches and warms the model so the first image doesn't pay for it. Safe to call many times.
 * Resolves with the engine that actually came up, which is "wasm" after a WebGPU fallback.
 * On WebGPU the frame does the fetching and warming, and its first run is the self-check.
 */
export async function preloadModel(onProgress?: (p: Progress) => void): Promise<Engine> {
  let engine = await resolveEngine();
  let raw = makeProgressMapper(engine, onProgress);
  listeners.add(raw);
  try {
    try {
      if (engine === "webgpu") await verifyGpuOnce();
      else await initLibrary(await loadLibrary(), libraryConfig(engine));
    } catch (error) {
      if (engine !== "webgpu" || isTransferError(error)) throw error;
      rememberGpuFailure("error");
      // A fresh mapper: the WebAssembly files must not be added on top of the WebGPU total.
      listeners.delete(raw);
      engine = "wasm";
      raw = makeProgressMapper(engine, onProgress);
      listeners.add(raw);
      await initLibrary(await loadLibrary(), libraryConfig(engine));
    }
    return engine;
  } finally {
    listeners.delete(raw);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Pixels
 * ---------------------------------------------------------------------------------------------- */

/** The subset of the 2D context both `OffscreenCanvas` and `<canvas>` share and that we use. */
type Ctx = CanvasDrawImage &
  CanvasRect &
  CanvasFillStrokeStyles &
  CanvasFilters &
  CanvasImageSmoothing &
  CanvasState &
  CanvasPath &
  CanvasDrawPath &
  CanvasTransform &
  CanvasImageData;

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

/**
 * The library decodes PNG, JPEG and WebP itself; everything else (GIF, BMP, AVIF, files with
 * no type) throws inside it, so those are handed over as PNG from the bitmap we already have.
 */
const PASSTHROUGH = /^image\/(png|jpe?g|webp)$/i;

/**
 * Downscales when needed, re-encodes formats the library cannot read, and reports the
 * resulting pixel size. A photo the library can read at a size it may see is passed through
 * without a decode; anything else is decoded straight to its fitted size (see decode.ts),
 * so no full-size bitmap exists here. An animated GIF yields its first frame, which is the
 * frame the cutout should come from.
 */
async function fit(file: Blob, edge: number): Promise<{ blob: Blob; width: number; height: number }> {
  const { width, height } = await loadImageMeta(file);
  const longest = Math.max(width, height);
  if (longest <= edge && PASSTHROUGH.test(file.type)) return { blob: file, width, height };

  const scale = Math.min(1, edge / longest);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bitmap = await decodeScaled(file, w, h, "high");
  try {
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
 * Re-encodes to PNG when the longest edge exceeds the edge (the site limit, or the smaller
 * one of a low-memory visit, see `maxEdge` in memory.ts) or the format is one the library
 * cannot decode; returns the same Blob otherwise. `removeBackground` does this itself, so
 * only call it when the fitted Blob is needed on its own.
 */
export async function downscaleIfNeeded(file: Blob, edge = maxEdge()): Promise<Blob> {
  const { blob } = await fit(file, edge);
  return blob;
}

/* ------------------------------------------------------------------------------------------------
 * Removal
 * ---------------------------------------------------------------------------------------------- */

/**
 * Removes the background. Downloads the model on first use (reported through onProgress), runs
 * WebGPU when available (and the engine preference allows it) and falls back to WebAssembly
 * once if WebGPU fails or fails its self-check. Rejects with DOMException "AbortError" when
 * the signal fires.
 */
export async function removeBackground(
  file: Blob,
  opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void },
): Promise<RemoveResult> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError();

  const lib = await loadLibrary();
  const input = await fit(file, maxEdge());
  if (signal?.aborted) throw abortError();

  const engine = await resolveEngine();
  try {
    return await runOnce(lib, engine, input, opts);
  } catch (error) {
    if (engine !== "webgpu" || signal?.aborted || isAbort(error) || isTransferError(error)) throw error;
    // WebGPU init, its self-check or the inference blew up: remember it and give WebAssembly one go on this image.
    rememberGpuFailure("error");
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
  const raw = makeProgressMapper(engine, opts?.onProgress);
  listeners.add(raw);
  try {
    let run: () => Promise<Blob>;
    if (engine === "webgpu") {
      // The self-check covers the preload in the normal flow; here for callers that skipped it
      // or switched the preference back to automatic mid-session. Rejects on a wrong mask, like
      // a thrown run. The frame it opened then takes the photo.
      await withAbort(verifyGpuOnce(), signal);
      const frame = await gpuFrame();
      run = () => frame.run(input.blob);
    } else {
      const config = libraryConfig(engine);
      await withAbort(initLibrary(lib, config), signal);
      run = () => lib.removeBackground(input.blob, config);
    }

    // The library cannot cancel a running job, so on abort we let it finish in the background and
    // simply refuse to hand the result over. The swallowed catch avoids an unhandled rejection.
    // Runs are chained (see `serial`), and a card abandoned while it waited never reaches the GPU.
    // The clock starts after preload so the download is excluded and an abandoned job's leftover
    // progress events (the listeners are shared) cannot inflate it.
    let t0 = 0;
    const work = serial(() => {
      if (signal?.aborted) return Promise.reject(abortError());
      t0 = performance.now();
      return run();
    });
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
 * The WebGPU frame
 * ---------------------------------------------------------------------------------------------- */

/**
 * WebGPU never runs in this document: it runs in a hidden same-origin iframe at `GPU_FRAME_PATH`
 * (the frame side is `src/lib/gpu-frame.ts`). ONNX Runtime keeps one global "initialized"
 * flag per document, and the library's WebGPU configuration runs it through a proxy worker;
 * once that init has happened (or failed) here, a later WebAssembly session in the same
 * document cannot start ("WebAssembly is not initialized yet", "previous call to initWasm()
 * failed"), so a fallback after any WebGPU attempt, thrown or wrong, would be stuck. With the
 * attempt in its own document this page's runtime stays clean for WebAssembly. The weights
 * are fetched once: the frame shares the browser's HTTP cache, and the CDN marks them cacheable.
 *
 * The protocol is one request at a time (`serial` chains the runs) with a progress relay;
 * `id` ties replies and progress to their request.
 */

/** The `type` of every message either way; anything else on the window is ignored. */
export const FRAME_MESSAGE = "rmbg:gpu";

/** What the page asks of the frame: warm the model, or run it on a picture. */
export type FrameOp = { op: "preload" } | { op: "run"; blob: Blob };

export type FrameRequest = { type: typeof FRAME_MESSAGE; id: number } & FrameOp;

export type FrameReply =
  | { type: typeof FRAME_MESSAGE; phase: "ready" }
  | { type: typeof FRAME_MESSAGE; phase: "progress"; id: number; key: string; current: number; total: number }
  | { type: typeof FRAME_MESSAGE; phase: "done"; id: number; blob?: Blob }
  | { type: typeof FRAME_MESSAGE; phase: "error"; id: number; message: string; transfer: boolean };

/**
 * A failure reported by the frame, or the frame itself not answering. `transfer` says whether
 * it was the network (the frame judged its own error with `isTransferError`; a frame that never
 * loaded counts too, since the page could not reach its own route), so the caller keeps WebGPU.
 */
class GpuFrameError extends Error {
  constructor(
    message: string,
    readonly transfer: boolean,
  ) {
    super(message);
    this.name = "GpuFrameError";
  }
}

type GpuFrame = {
  /** Fetches and warms the model in the frame. */
  preload(): Promise<void>;
  /** Runs the model on `blob`; `quiet` keeps the run's compute progress off this page (the self-check). */
  run(blob: Blob, opts?: { quiet?: boolean }): Promise<Blob>;
  close(): void;
};

/** How long the frame gets to load and say "ready": its own route on the same origin, so seconds. */
const FRAME_READY_MS = 30_000;

let frameOpening: Promise<GpuFrame> | undefined;
let frameOpen: GpuFrame | null = null;

/** The frame, opened on first use and kept for the session (it holds the resident session). */
function gpuFrame(): Promise<GpuFrame> {
  if (!frameOpening) {
    frameOpening = openGpuFrame().catch((error: unknown) => {
      frameOpening = undefined;
      throw error;
    });
  }
  return frameOpening;
}

function closeGpuFrame(): void {
  frameOpen?.close();
}

function isFrameReply(data: unknown): data is FrameReply {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === FRAME_MESSAGE;
}

function openGpuFrame(): Promise<GpuFrame> {
  return new Promise<GpuFrame>((resolveOpen, rejectOpen) => {
    const frame = document.createElement("iframe");
    frame.src = GPU_FRAME_PATH;
    frame.title = "WebGPU engine";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    // Off the page but not display:none, which some browsers take as a reason not to load a frame.
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;overflow:hidden;visibility:hidden;pointer-events:none";

    type Pending = { resolve: (blob?: Blob) => void; reject: (error: Error) => void; quiet: boolean };
    const pending = new Map<number, Pending>();
    let nextId = 0;
    let ready = false;

    const close = () => {
      clearTimeout(readyTimer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      if (frameOpen === client) frameOpen = null;
      frameOpening = undefined;
      const gone = new GpuFrameError("The WebGPU frame was closed.", false);
      for (const p of pending.values()) p.reject(gone);
      pending.clear();
      if (!ready) rejectOpen(new GpuFrameError("The WebGPU frame did not load.", true));
    };

    const readyTimer = setTimeout(close, FRAME_READY_MS);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || !isFrameReply(event.data)) return;
      const reply = event.data;
      switch (reply.phase) {
        case "ready":
          if (ready) return;
          ready = true;
          clearTimeout(readyTimer);
          frameOpen = client;
          resolveOpen(client);
          return;
        case "progress":
          // The self-check's inference must not read as a run on this page; its download is the model's.
          if (!pending.get(reply.id)?.quiet || reply.key.startsWith("fetch:")) dispatchProgress(reply.key, reply.current, reply.total);
          return;
        case "done":
          pending.get(reply.id)?.resolve(reply.blob);
          pending.delete(reply.id);
          return;
        case "error":
          pending.get(reply.id)?.reject(new GpuFrameError(reply.message, reply.transfer));
          pending.delete(reply.id);
          return;
      }
    };

    const call = (op: FrameOp, quiet = false) =>
      new Promise<Blob | undefined>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, quiet });
        const request: FrameRequest = { type: FRAME_MESSAGE, id, ...op };
        frame.contentWindow?.postMessage(request, location.origin);
      });

    const client: GpuFrame = {
      preload: () => call({ op: "preload" }).then(() => undefined),
      run: async (blob, opts) => {
        const out = await call({ op: "run", blob }, opts?.quiet);
        if (!out) throw new GpuFrameError("The WebGPU frame returned no image.", false);
        return out;
      },
      close,
    };

    window.addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

/* ------------------------------------------------------------------------------------------------
 * WebGPU self-check
 * ---------------------------------------------------------------------------------------------- */

/** Thrown by the self-check when the mask came back, but wrong. */
class WrongResultError extends Error {
  constructor() {
    super("WebGPU returned a wrong mask for the self-check picture.");
    this.name = "WrongResultError";
  }
}

/** The self-check picture's edge. Small, so the check costs one quick run; the model resizes anyway. */
const SELF_CHECK_SIZE = 256;

/**
 * The picture scripts/e2e.mjs `makeTestPng` draws (a shaded ball on a dark wall, lit from the
 * upper left, with a ground shadow), scaled from its 800x600 space into the square. A plain
 * disc on a flat ground leaves the model unsure; a lit sphere is cut cleanly on every engine.
 */
async function drawSelfCheckImage(): Promise<Blob> {
  const size = SELF_CHECK_SIZE;
  const { canvas, ctx } = makeSurface(size, size);
  const s = size / 600;
  ctx.translate((size - 800 * s) / 2, 0);
  ctx.scale(s, s);
  const wall = ctx.createLinearGradient(0, 0, 0, 600);
  wall.addColorStop(0, "#343a42");
  wall.addColorStop(1, "#22262c");
  ctx.fillStyle = wall;
  ctx.fillRect(-200, 0, 1200, 600);
  ctx.save();
  ctx.translate(410, 550);
  ctx.scale(1, 0.18);
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 216);
  shadow.addColorStop(0, "rgba(0,0,0,.45)");
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(0, 0, 216, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const ball = ctx.createRadialGradient(328, 204, 0, 328, 204, 384);
  ball.addColorStop(0, "#ffb86b");
  ball.addColorStop(0.5, "#c2410c");
  ball.addColorStop(1, "#4a1506");
  ctx.fillStyle = ball;
  ctx.beginPath();
  ctx.arc(400, 300, 240, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.beginPath();
  ctx.ellipse(340, 230, 45, 30, 0, 0, Math.PI * 2);
  ctx.fill();
  return toPng(canvas);
}

/** Decodes a PNG to straight RGBA bytes. */
async function readRgba(blob: Blob): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const { ctx } = makeSurface(width, height);
    ctx.drawImage(bitmap, 0, 0);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } finally {
    bitmap.close();
  }
}

let selfCheck: Promise<void> | undefined;

/**
 * Opens the frame, has it fetch and warm the model, runs the synthetic picture through it and
 * judges the mask, once per session, on the WebGPU path only. The result is cached: the
 * preload and the first job await the same run. A wrong mask, or anything else the frame
 * throws, is remembered as a WebGPU failure with its reason and the rejection makes the
 * caller fall back exactly like a thrown run. Network trouble is the exception: it is thrown
 * as it is, nothing is remembered, and the next call checks again.
 */
function verifyGpuOnce(): Promise<void> {
  if (!selfCheck) {
    selfCheck = (async () => {
      const frame = await gpuFrame();
      await frame.preload();
      // The frame's own `initLibrary` told its document, not this one.
      notifyModelLoaded("webgpu");
      const picture = await drawSelfCheckImage();
      const out = await frame.run(picture, { quiet: true });
      const { data, width, height } = await readRgba(out);
      if (!maskLooksSane(data, width, height)) throw new WrongResultError();
    })().catch((error: unknown) => {
      if (isTransferError(error)) {
        selfCheck = undefined;
        throw error;
      }
      rememberGpuFailure(error instanceof WrongResultError ? "wrong-result" : "error");
      throw error;
    });
    // Nobody may be listening yet (a caller that aborted); the rejection reaches the next one anyway.
    selfCheck.catch(() => {});
  }
  return selfCheck;
}

/* ------------------------------------------------------------------------------------------------
 * Compose
 * ---------------------------------------------------------------------------------------------- */

/** Paints the cutout over the chosen backdrop (transparent, a flat colour, or the blurred original) and returns a PNG. */
export async function composeBackdrop(cutout: Blob, original: Blob, backdrop: Backdrop): Promise<Blob> {
  const fg = await decodeFull(cutout);
  try {
    const { width, height } = fg;
    const { canvas, ctx } = makeSurface(width, height);

    if (backdrop.kind === "color") {
      ctx.fillStyle = backdrop.hex;
      ctx.fillRect(0, 0, width, height);
    } else if (backdrop.kind === "blur") {
      // At the cutout's size, not the original's: it is blurred anyway, and a phone photo decoded whole is tens of MB.
      const bg = await decodeScaled(original, width, height, "high");
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
