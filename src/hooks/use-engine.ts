"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getEnginePreference,
  gpuFallbackReason,
  preloadModel,
  resolveEngine,
  setEnginePreference,
  subscribeEnginePreference,
  type Engine,
  type EnginePreference,
  type Progress,
} from "@/lib/remove";
import { useToast } from "@/components/ui/toast";

export type Download = { loaded: number; total: number };

const FALLBACK_NOTICE = {
  error: "Your graphics chip couldn't run the model, so it runs on your processor instead.",
  "wrong-result": "Your graphics chip gave a wrong cutout, so the model now runs on your processor. Slower, but right.",
} as const;

const PREFERENCE_NOTICE: Record<EnginePreference, string> = {
  wasm: "The next photo uses your processor. Slower, but it works on every device.",
  auto: "The next photo uses your graphics chip when it gives a good cutout.",
};

/**
 * Owns the model: which backend it runs on, the one-time download and its progress.
 * `ensure()` preloads at most once and is safe to call from every intent (a pointerdown on
 * the pick button, the first drag, the first card). A failed preload forgets its promise so
 * the next `ensure()` tries again.
 */
export type EngineOptions = {
  /**
   * Fired once when the weights start arriving, at each quarter (`pct` 25, 50, 75) so a live
   * region has something to say during a long download, and once when it is over.
   */
  onDownload?: (phase: "start" | "end" | "progress", pct?: number) => void;
};

export function useEngine(opts: EngineOptions = {}) {
  const { push } = useToast();
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  /** The engine the next job will run on (null until detection finishes); the label under the photo. */
  const [engine, setEngine] = useState<Engine | null>(null);
  // Module state in remove.ts (the URL, then localStorage); "auto" on the server so markup hydrates cleanly.
  const preference = useSyncExternalStore(subscribeEnginePreference, getEnginePreference, () => "auto" as EnginePreference);
  const [download, setDownload] = useState<Download | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promise = useRef<Promise<void> | null>(null);
  const readyRef = useRef(false);
  const fellBack = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(resolveEngine)
      .then((e) => {
        if (live) setEngine(e);
      })
      .catch(() => {
        /* the engine label stays unknown until a result reports it */
      });
    return () => {
      live = false;
    };
  }, []);

  /** Called with the engine a finished job actually ran on; toasts once if WebGPU fell back, saying why. */
  const noteResult = useCallback(
    (used: Engine) => {
      const reason = used === "wasm" && !fellBack.current ? gpuFallbackReason() : null;
      if (reason) {
        fellBack.current = true;
        push("info", FALLBACK_NOTICE[reason]);
      }
      // A job that ran on WebGPU says nothing about the next one once the preference is WebAssembly.
      setEngine(used === "webgpu" && getEnginePreference() === "wasm" ? "wasm" : used);
    },
    [push],
  );

  /** Flips auto <-> WebAssembly for the next job; the running one is left alone. */
  const toggle = useCallback(() => {
    const next: EnginePreference = getEnginePreference() === "wasm" ? "auto" : "wasm";
    setEnginePreference(next);
    push("info", PREFERENCE_NOTICE[next]);
    resolveEngine()
      .then(setEngine)
      .catch(() => {
        /* the label follows the next result instead */
      });
  }, [push]);

  const ensure = useCallback((): Promise<void> => {
    if (readyRef.current) return Promise.resolve();
    if (!promise.current) {
      setError(null);
      let started = false;
      let lastQuarter = 0;
      const onProgress = (p: Progress) => {
        if (p.kind !== "download") return;
        if (!started) {
          started = true;
          optsRef.current.onDownload?.("start");
        }
        // Quarters only while bytes are still in flight; the end is announced on its own.
        const quarter = p.total > 0 && p.loaded < p.total ? Math.floor((p.loaded / p.total) * 4) : 0;
        if (quarter > lastQuarter) {
          lastQuarter = quarter;
          optsRef.current.onDownload?.("progress", quarter * 25);
        }
        setDownload({ loaded: p.loaded, total: p.total });
      };
      promise.current = Promise.resolve()
        .then(() => preloadModel(onProgress))
        .then((used) => {
          // The preload may have fallen back to WebAssembly; say so now, not at the first result.
          noteResult(used);
          readyRef.current = true;
          setReady(true);
          setDownload(null);
          if (started) optsRef.current.onDownload?.("end");
        })
        .catch((e: unknown) => {
          promise.current = null;
          setDownload(null);
          setError(e instanceof Error ? e.message : "model download failed");
          // A WebGPU attempt that failed on the way to WebAssembly leaves the next job on WebAssembly; say so now.
          resolveEngine()
            .then(setEngine)
            .catch(() => {
              /* the label follows the next result instead */
            });
          throw e;
        });
    }
    return promise.current;
  }, [noteResult]);

  const isReady = useCallback(() => readyRef.current, []);

  return { engine, preference, toggle, download, ready, error, ensure, isReady, noteResult };
}

export type EngineHandle = ReturnType<typeof useEngine>;
