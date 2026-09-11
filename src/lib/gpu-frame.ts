/**
 * The frame side of the WebGPU frame (see "The WebGPU frame" in remove.ts): runs in the
 * document the page opens at `GPU_FRAME_PATH` and answers its requests with the library's
 * WebGPU configuration. Every progress event the library raises here is relayed to the page,
 * which maps it like its own. Browser only; imported by the frame's client component.
 */

import { FRAME_MESSAGE, initLibrary, isTransferError, libraryConfig, loadLibrary, onRawProgress, type FrameReply, type FrameRequest } from "@/lib/remove";

function isFrameRequest(data: unknown): data is FrameRequest {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === FRAME_MESSAGE;
}

/** Starts answering the parent; returns the function that stops. A no-op when not framed. */
export function serveGpuFrame(): () => void {
  const parent = window.parent;
  if (parent === window) return () => {};
  const post = (reply: FrameReply) => parent.postMessage(reply, location.origin);

  // The request the library is working on, for tagging its progress. One at a time: the page
  // chains its runs, and a preload beside a run is a memoised no-op inside the library.
  let current = -1;
  const stopProgress = onRawProgress((key, done, total) => post({ type: FRAME_MESSAGE, phase: "progress", id: current, key, current: done, total }));

  const onMessage = async (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== location.origin || !isFrameRequest(event.data)) return;
    const request = event.data;
    current = request.id;
    try {
      const lib = await loadLibrary();
      const config = libraryConfig("webgpu");
      await initLibrary(lib, config);
      const blob = request.op === "run" ? await lib.removeBackground(request.blob, config) : undefined;
      post({ type: FRAME_MESSAGE, phase: "done", id: request.id, blob });
    } catch (error) {
      post({ type: FRAME_MESSAGE, phase: "error", id: request.id, message: error instanceof Error ? error.message : String(error), transfer: isTransferError(error) });
    }
  };

  window.addEventListener("message", onMessage);
  post({ type: FRAME_MESSAGE, phase: "ready" });
  return () => {
    window.removeEventListener("message", onMessage);
    stopProgress();
  };
}
