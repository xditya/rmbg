"use client";

import { useSyncExternalStore } from "react";

/** A media query as state, false on the server so markup hydrates cleanly. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

const noop = () => () => {};

/** A browser-only fact (feature detection) as state, `fallback` on the server. */
export function useClientFact<T>(read: () => T, fallback: T): T {
  return useSyncExternalStore(noop, read, () => fallback);
}
