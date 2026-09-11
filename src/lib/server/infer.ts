/**
 * The server engine: ISNet (the quint8 weights the browser's WebAssembly path uses) on
 * onnxruntime-node, with sharp for decoding, resizing and composing. One session per process,
 * created lazily and shared; at most `API.concurrency` runs at once, a short queue behind
 * them, and nothing is kept once the response is built. Server only: never import from
 * client code.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ort from "onnxruntime-node";
import sharp, { type Metadata, type Sharp } from "sharp";
import { blurRadius } from "@/lib/backdrop";
import { API, LIMITS } from "@/lib/config";

/** The model's fixed input size. */
const SIDE = 1024;
/** How long a model fetch may take before the session promise gives up and resets. */
const FETCH_TIMEOUT_MS = 30_000;
/** What we accept once the bytes are sniffed. sharp also reads svg and raw; those are not photos. */
const FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "heif", "tiff"]);

/** The bytes are not an image we read. */
export class UnsupportedImageError extends Error {
  name = "UnsupportedImageError";
}
/** The bytes look like an image but do not decode. */
export class InvalidImageError extends Error {
  name = "InvalidImageError";
}
/** The queue is full. */
export class BusyError extends Error {
  name = "BusyError";
}
/** The model or its runtime failed. */
export class EngineError extends Error {
  name = "EngineError";
}

export type Backdrop = { kind: "transparent" } | { kind: "color"; r: number; g: number; b: number } | { kind: "blur" };
export type Format = "png" | "webp";

export type RemoveOptions = { backdrop: Backdrop; format: Format };
export type RemoveResult = { bytes: Buffer; width: number; height: number; ms: number; contentType: string };

/* ------------------------------------------------------------------------------------------ sniff */

export type Sniffed = { format: string; width: number; height: number };

/** Reads the header only. Throws UnsupportedImageError for anything that is not a raster image we take. */
export async function sniff(bytes: Buffer): Promise<Sniffed> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    throw new UnsupportedImageError("That is not an image we can read. Send a JPEG, PNG, WebP, GIF, AVIF or TIFF.");
  }
  const format = meta.format ?? "";
  if (!FORMATS.has(format)) throw new UnsupportedImageError(`${format || "That"} is not a format we take. Send a JPEG, PNG, WebP, GIF, AVIF or TIFF.`);
  return { format, width: meta.width, height: meta.height };
}

/* ------------------------------------------------------------------------------------------ model */

const MODEL_KEY = "/models/isnet_quint8";
const MODEL_FILE = "isnet_quint8.onnx";

type Resources = Record<string, { chunks: { name: string; hash?: string }[]; size: number }>;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function modelBase(): string {
  const base = process.env.RMBG_MODEL_URL || API.modelBaseUrl;
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * The weights are pinned: the CDN's file must match the size and sha256 in config, and a
 * mirror (`RMBG_MODEL_URL`) must match `RMBG_MODEL_SHA256` when that is set. Anything else,
 * from the network or the shared tmp cache, is refused rather than handed to the runtime.
 */
function checkModel(model: Buffer): void {
  const mirror = !!process.env.RMBG_MODEL_URL;
  const pin = mirror ? process.env.RMBG_MODEL_SHA256?.trim().toLowerCase() : API.modelSha256;
  if (!mirror && model.length !== API.modelBytes) throw new EngineError(`model size ${model.length}, expected ${API.modelBytes}`);
  if (pin && sha256(model) !== pin) throw new EngineError("model sha256 mismatch");
}

async function fetchModel(): Promise<Buffer> {
  const base = modelBase();
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(`${base}resources.json`, { signal });
  if (!res.ok) throw new EngineError(`resources.json: ${res.status}`);
  const entry = ((await res.json()) as Resources)[MODEL_KEY];
  if (!entry?.chunks?.length) throw new EngineError("model missing from resources.json");
  const parts = await Promise.all(
    entry.chunks.map(async (c) => {
      const r = await fetch(base + c.name, { signal });
      if (!r.ok) throw new EngineError(`chunk ${c.name}: ${r.status}`);
      const part = Buffer.from(await r.arrayBuffer());
      if (c.hash && sha256(part) !== c.hash) throw new EngineError(`chunk ${c.name}: hash mismatch`);
      return part;
    }),
  );
  const model = Buffer.concat(parts);
  if (model.length !== entry.size) throw new EngineError(`model size ${model.length}, expected ${entry.size}`);
  checkModel(model);
  return model;
}

/** The weights, from the tmp cache when it has them and they check out, else from the CDN (then cached, written atomically). */
async function loadModel(): Promise<Buffer> {
  const dir = join(tmpdir(), "rmbg");
  const path = join(dir, MODEL_FILE);
  try {
    const cached = await readFile(path);
    checkModel(cached);
    return cached;
  } catch {
    // not cached yet, or not the file we wrote: fetch, and let the fresh copy replace it
  }
  const model = await fetchModel();
  const tmp = `${path}.${process.pid}.${Date.now()}.part`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, model);
    await rename(tmp, path);
  } catch {
    // a read-only tmp is fine: the model is in memory for this process
    await rm(tmp, { force: true }).catch(() => {});
  }
  return model;
}

let sessionPromise: Promise<ort.InferenceSession> | undefined;

/** One InferenceSession per process. A failed creation is forgotten so the next call retries; a stale cache file is dropped. */
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const model = await loadModel();
      try {
        return await ort.InferenceSession.create(model, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
      } catch (e) {
        await rm(join(tmpdir(), "rmbg", MODEL_FILE), { force: true }).catch(() => {});
        throw e;
      }
    })();
    sessionPromise.catch(() => {
      sessionPromise = undefined;
    });
  }
  return sessionPromise;
}

/** Fetches and loads the model without running anything; for warm-up. */
export function warm(): Promise<unknown> {
  return getSession();
}

/* ------------------------------------------------------------------------------------------ queue */

let running = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < API.concurrency) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= API.maxQueue) return Promise.reject(new BusyError("queue full"));
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // hands the slot over: `running` stays the same
  else running--;
}

/* ------------------------------------------------------------------------------------------ run */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** `#rgb` or `#rrggbb`, with or without the hash; null for anything else. */
export function parseHex(value: string): { r: number; g: number; b: number } | null {
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? hexToRgb(value) : null;
}

function isDecodeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return /unsupported image format|Input buffer|corrupt|truncated|premature|VipsJpeg|VipsPng|pngload|jpegload|webpload|gifload|heifload|tiffload|bad seek|Invalid/i.test(msg);
}

/** Decodes, rotates by EXIF, downscales to the page's edge cap and returns RGBA pixels. */
async function decode(bytes: Buffer): Promise<{ base: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: LIMITS.apiMaxPixels, animated: false })
      .rotate()
      .resize({ width: LIMITS.maxEdge, height: LIMITS.maxEdge, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { base: data, width: info.width, height: info.height };
  } catch (e) {
    if (isDecodeError(e)) throw new InvalidImageError("That image didn't decode. Try a JPEG or PNG.");
    throw e;
  }
}

/** Runs the model on `base` (RGBA, width×height) and writes the mask into its alpha channel. */
async function mask(base: Buffer, width: number, height: number): Promise<void> {
  const rgb = await sharp(base, { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .resize(SIDE, SIDE, { fit: "fill" })
    .raw()
    .toBuffer();
  const plane = SIDE * SIDE;
  const input = new Float32Array(3 * plane);
  for (let i = 0, j = 0; j < plane; i += 3, j++) {
    input[j] = (rgb[i] - 128) / 256;
    input[j + plane] = (rgb[i + 1] - 128) / 256;
    input[j + 2 * plane] = (rgb[i + 2] - 128) / 256;
  }
  let session: ort.InferenceSession;
  let out: Float32Array;
  try {
    session = await getSession();
    const result = await session.run({ input: new ort.Tensor("float32", input, [1, 3, SIDE, SIDE]) });
    out = result.output.data as Float32Array;
  } catch (e) {
    throw new EngineError("run failed", { cause: e });
  }
  const m8 = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) m8[i] = Math.max(0, Math.min(255, Math.round(out[i] * 255)));
  // resize() re-expands a 1-channel raw image; force b-w and read with the stride it reports.
  const { data: alpha, info } = await sharp(m8, { raw: { width: SIDE, height: SIDE, channels: 1 } })
    .resize(width, height, { fit: "fill" })
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = info.channels;
  // The model leaves a faint haze (1 or 2 of 255) on a few background pixels and stops just
  // short of 255 on the subject; snap the last 1% either way so the background is really clear.
  for (let p = 0, n = width * height; p < n; p++) {
    const a = alpha[p * stride];
    base[p * 4 + 3] = a <= 2 ? 0 : a >= 253 ? 255 : a;
  }
}

/** Puts the cutout over the chosen backdrop and encodes it. */
async function compose(base: Buffer, width: number, height: number, source: Buffer, opts: RemoveOptions): Promise<Buffer> {
  const raw = { width, height, channels: 4 as const };
  let img: Sharp;
  switch (opts.backdrop.kind) {
    case "transparent":
      img = sharp(base, { raw });
      break;
    case "color": {
      const { r, g, b } = opts.backdrop;
      img = sharp(base, { raw }).flatten({ background: { r, g, b } });
      break;
    }
    case "blur": {
      // Blur at a small size and scale back up: the same look as the page's blur for a fraction of the work.
      const radius = blurRadius(width, height);
      const scale = Math.min(1, 512 / Math.max(width, height));
      const small = await sharp(source, { limitInputPixels: LIMITS.apiMaxPixels, animated: false })
        .rotate()
        .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { fit: "fill" })
        .removeAlpha()
        .blur(Math.max(0.3, radius * scale))
        .raw()
        .toBuffer({ resolveWithObject: true });
      img = sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: small.info.channels as 3 | 4 } })
        .resize(width, height, { fit: "fill" })
        .composite([{ input: base, raw }]);
      break;
    }
  }
  return opts.format === "webp" ? img.webp({ quality: API.webpQuality }).toBuffer() : img.png().toBuffer();
}

/**
 * Removes the background from one photo. Throws UnsupportedImageError / InvalidImageError for
 * bad input, BusyError when the queue is full, EngineError when the model fails.
 */
export async function remove(bytes: Buffer, opts: RemoveOptions): Promise<RemoveResult> {
  await acquire();
  const t0 = performance.now();
  try {
    const { base, width, height } = await decode(bytes);
    await mask(base, width, height);
    const out = await compose(base, width, height, bytes, opts);
    return {
      bytes: out,
      width,
      height,
      ms: Math.round(performance.now() - t0),
      contentType: opts.format === "webp" ? "image/webp" : "image/png",
    };
  } finally {
    release();
  }
}
