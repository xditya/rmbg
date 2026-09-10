/**
 * The engine: everything that touches pixels or the model lives here, so the UI only ever
 * deals with Blobs and progress events. Runs in the browser only; import lazily from client code.
 *
 * Contract (the UI is written against these signatures; keep them stable):
 */

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

/** Probes WebGPU once and remembers the answer. Never throws. */
export function detectEngine(): Promise<Engine> {
  throw new Error("not implemented");
}

/** Fetches and warms the model so the first image doesn't pay for it. Safe to call many times. */
export function preloadModel(onProgress?: (p: Progress) => void): Promise<void> {
  void onProgress;
  throw new Error("not implemented");
}

/** Reads pixel dimensions. Rejects with a friendly Error when the browser can't decode the format. */
export function loadImageMeta(file: Blob): Promise<{ width: number; height: number }> {
  void file;
  throw new Error("not implemented");
}

/** Re-encodes to PNG when the longest edge exceeds maxEdge; returns the same Blob otherwise. */
export function downscaleIfNeeded(file: Blob, maxEdge: number): Promise<Blob> {
  void file;
  void maxEdge;
  throw new Error("not implemented");
}

/**
 * Removes the background. Downloads the model on first use (reported through onProgress), runs
 * WebGPU when available and falls back to WebAssembly once if WebGPU fails. Rejects with
 * DOMException "AbortError" when the signal fires.
 */
export function removeBackground(file: Blob, opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void }): Promise<RemoveResult> {
  void file;
  void opts;
  throw new Error("not implemented");
}

/** Paints the cutout over the chosen backdrop (transparent, a flat colour, or the blurred original) and returns a PNG. */
export function composeBackdrop(cutout: Blob, original: Blob, backdrop: Backdrop): Promise<Blob> {
  void cutout;
  void original;
  void backdrop;
  throw new Error("not implemented");
}
