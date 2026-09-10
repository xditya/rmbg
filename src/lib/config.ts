/** Site-wide constants. Safe to import from server and client code. */
import type { Engine } from "@/lib/remove";

export const SITE = {
  name: "rmbg",
  tagline: "Drop a photo, keep the subject.",
  description: "Remove the background from any image, right in your browser. Nothing is uploaded: the model runs on your device and the photo never leaves it.",
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
