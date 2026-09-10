"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";

export type Size = { width: number; height: number };

/**
 * Measures an element's content box and returns the largest box with the given aspect
 * ratio that fits inside it. `box` is the raw measurement (null before the first one) for
 * callers that need to size something before the ratio is known.
 */
export function useFitRect(ref: RefObject<HTMLElement | null>, w?: number, h?: number): { box: Size | null; rect: Size | null } {
  const [box, setBox] = useState<Size | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setBox((prev) => (prev && prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  const rect = useMemo(() => {
    if (!box || !w || !h || box.width <= 0 || box.height <= 0) return null;
    const s = Math.min(box.width / w, box.height / h);
    return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)) };
  }, [box, w, h]);

  return { box, rect };
}
