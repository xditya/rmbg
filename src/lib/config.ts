/** Site-wide constants. Safe to import from server and client code. */
import type { Engine } from "@/lib/remove";

export const SITE = {
  name: "rmbg",
  tagline: "Drop a photo, keep the subject.",
  description: "Remove the background from a photo, right in your browser. Nothing is uploaded: the model runs on your device and the photo never leaves it.",
  repo: "https://github.com/xditya/rmbg",
} as const;

export const LIMITS = {
  /** Largest file we will try. Bigger photos are downscaled before inference anyway. */
  maxBytes: 25 * 1024 * 1024,
  /** Longest edge we feed the model; bigger photos are scaled down first and the cutout stays at that size. */
  maxEdge: 4096,
  /** Most files one drop can add; the rest are skipped with a toast. */
  maxFiles: 30,
  accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"],
  /** Largest body the HTTP API takes. Smaller than the page's cap: the photo travels over the network and is held in server memory. */
  apiMaxBytes: 12 * 1024 * 1024,
  /** Most pixels the API decodes for one photo (RGBA, so ×4 bytes in memory). 8K is 33 MP; bigger photos are refused, not downscaled. */
  apiMaxPixels: 40_000_000,
} as const;

/**
 * The route the page frames to run WebGPU in (see `src/lib/remove.ts`): a hidden same-origin
 * iframe, so a failed or wrong WebGPU attempt never touches this page's ONNX Runtime and the
 * WebAssembly fallback always starts from a clean one. The CSP in `src/proxy.ts` lets this
 * one path be framed by the site itself.
 */
export const GPU_FRAME_PATH = "/gpu-frame";

/** imgly's CDN, the directory with `resources.json` and the content-addressed chunks of the weights and the runtime. */
const MODEL_CDN_URL = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";

const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

/**
 * `NEXT_PUBLIC_MODEL_URL` checked: an absolute http(s) URL or nothing. Anything else (a host
 * without a scheme, a typo) fails here, at build time, with a message that names the value,
 * instead of every page answering 500 once the proxy tries to read its origin.
 */
function modelBaseUrl(): string {
  const given = process.env.NEXT_PUBLIC_MODEL_URL?.trim();
  if (!given) return MODEL_CDN_URL;
  let url: URL | null = null;
  try {
    url = new URL(given);
  } catch {
    /* reported below */
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`NEXT_PUBLIC_MODEL_URL must be an absolute http(s) URL, the directory with resources.json and the chunks (got "${given}")`);
  }
  return withSlash(url.href);
}

/**
 * Where the browser fetches the weights and the runtime: `NEXT_PUBLIC_MODEL_URL` (a mirror with
 * the CDN's layout; inlined at build time, so it needs a rebuild to change), else the CDN. The
 * library's `publicPath`, the service worker's allowlist (`public/sw.js`, told at registration)
 * and the CSP's `connect-src` all read this one value. The API has its own (`RMBG_MODEL_URL`).
 */
export const MODEL_BASE_URL = modelBaseUrl();

/** The origin of `MODEL_BASE_URL`, for the CSP's `connect-src`. */
export const MODEL_ORIGIN = new URL(MODEL_BASE_URL).origin;

/** The Cache Storage bucket the service worker keeps the chunks in. Bump the suffix to drop old ones on activate. */
export const MODEL_CACHE_NAME = "rmbg-models-v1";

/** The long edge photos are fitted to for the rest of the visit once the page has run out of memory mid-cut (`src/lib/memory.ts`). */
export const LOW_MEMORY_EDGE = 2048;

/** The HTTP API (`/api/v1`). The engine runs on the server with the WebAssembly-path weights. */
export const API = {
  path: "/api/v1/remove",
  engine: "onnxruntime-node",
  model: "isnet_quint8",
  /** Where the weights come from unless `RMBG_MODEL_URL` says otherwise. Same CDN and version the browser uses. */
  modelBaseUrl: MODEL_CDN_URL,
  /** The assembled `isnet_quint8.onnx` from that CDN (`MODEL_FILES.wasm` has the same size); anything else is refused. */
  modelBytes: 44_348_940,
  modelSha256: "d1ca3535c21b53d08fa3b640e5949389f82e764f6376a0502d44982c35cae482",
  backdrops: ["transparent", "white", "black", "#rrggbb", "blur"],
  formats: ["png", "webp"],
  webpQuality: 92,
  /** Requests per minute per IP unless `RATE_LIMIT_PER_MIN` overrides it. */
  ratePerMinute: 10,
  /** Runs at once per process, and how many may wait before the API answers 503. */
  concurrency: 2,
  maxQueue: 8,
  /** Vercel function cap, inside every plan's limit (300 s with Fluid Compute, 60 s on Hobby without); a run is 2 to 5 s. */
  maxDuration: 60,
} as const;

/**
 * What the library fetches on the first run, per engine, in bytes. Copied from the CDN's
 * `resources.json` for @imgly/background-removal-data 1.7.0 (the package's own copy is empty)
 * so the download total is honest from the first byte instead of growing file by file.
 * The library reports each file under `fetch:<key>`; unknown keys are still added as they show up.
 */
export const MODEL_FILES: Record<Engine, Record<string, number>> = {
  webgpu: {
    "/models/isnet_fp16": 88_152_708,
    "/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm": 23_013_109,
    "/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs": 49_241,
  },
  wasm: {
    "/models/isnet_quint8": 44_348_940,
    "/onnxruntime-web/ort-wasm-simd-threaded.wasm": 11_819_815,
    "/onnxruntime-web/ort-wasm-simd-threaded.mjs": 25_539,
  },
};

/** Total bytes the first run fetches on `engine`. */
export function modelDownloadBytes(engine: Engine): number {
  return Object.values(MODEL_FILES[engine]).reduce((a, b) => a + b, 0);
}

const roundMB = (bytes: number) => Math.round(bytes / (1024 * 1024) / 5) * 5;

/** "about 105 MB" once the engine is known, "55 to 105 MB" before that. Same 1024-based MB as the status line. */
export function modelDownloadNote(engine: Engine | null): string {
  if (engine) return `about ${roundMB(modelDownloadBytes(engine))} MB`;
  return `${roundMB(modelDownloadBytes("wasm"))} to ${roundMB(modelDownloadBytes("webgpu"))} MB`;
}

/** Whether an engine's files are in the service worker's cache; "unknown" where the Cache API is missing or the manifest could not be read. */
export type ModelStatus = "downloaded" | "missing" | "unknown";

/** The picker's badge for an engine: "Downloaded", "About 105 MB, downloads once", or the bare size when the cache cannot be read. */
export function modelCacheNote(engine: Engine, status: ModelStatus): string {
  if (status === "downloaded") return "Downloaded";
  const size = `About ${roundMB(modelDownloadBytes(engine))} MB`;
  return status === "missing" ? `${size}, downloads once` : size;
}
