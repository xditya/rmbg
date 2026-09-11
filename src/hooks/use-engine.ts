"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectEngine, preloadModel, type Engine, type Progress } from "@/lib/remove";
import { useToast } from "@/components/ui/toast";

export type Download = { loaded: number; total: number };

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
  const [engine, setEngine] = useState<Engine | null>(null);
  const [download, setDownload] = useState<Download | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promise = useRef<Promise<void> | null>(null);
  const readyRef = useRef(false);
  const fellBack = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(detectEngine)
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

  /** Called with the engine a finished job actually ran on; toasts once if WebGPU fell back. */
  const noteResult = useCallback(
    (used: Engine) => {
      setEngine((prev) => {
        if (prev === "webgpu" && used === "wasm" && !fellBack.current) {
          fellBack.current = true;
          queueMicrotask(() => push("info", "WebGPU didn't work here, using WebAssembly instead."));
        }
        return used;
      });
    },
    [push],
  );

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
          throw e;
        });
    }
    return promise.current;
  }, [noteResult]);

  const isReady = useCallback(() => readyRef.current, []);

  return { engine, download, ready, error, ensure, isReady, noteResult };
}

export type EngineHandle = ReturnType<typeof useEngine>;
