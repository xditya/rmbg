/**
 * The crash guard. A phone that runs out of memory mid-cut does not throw: Safari drops the
 * page and reloads it blank. So a job leaves a mark in sessionStorage while it runs and takes
 * it back when it settles; a mark that is still there when the page starts means the last
 * document went away mid-run, and the visit switches to a smaller working size. Browser only;
 * every call is safe without storage (private mode, blocked).
 */

import { LIMITS, LOW_MEMORY_EDGE } from "@/lib/config";
import type { Engine } from "@/lib/remove";

/** Set while a job runs: `{ engine, edge }` as JSON. */
export const INFLIGHT_KEY = "rmbg:inflight";
/** "1" once a reload mid-run has been seen this visit. */
export const LOW_MEMORY_KEY = "rmbg:low-memory";

export type Inflight = { engine: Engine | null; edge: number };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this visit is in low-memory mode: photos are fitted to `LOW_MEMORY_EDGE` before the cut. */
export function lowMemory(): boolean {
  return storage()?.getItem(LOW_MEMORY_KEY) === "1";
}

export function setLowMemory(): void {
  storage()?.setItem(LOW_MEMORY_KEY, "1");
}

/** The long edge photos are fitted to before the cut: the site limit, or the smaller one in low-memory mode. */
export function maxEdge(): number {
  return lowMemory() ? LOW_MEMORY_EDGE : LIMITS.maxEdge;
}

export function markInflight(engine: Engine | null): void {
  const mark: Inflight = { engine, edge: maxEdge() };
  storage()?.setItem(INFLIGHT_KEY, JSON.stringify(mark));
}

export function clearInflight(): void {
  storage()?.removeItem(INFLIGHT_KEY);
}

/** Reads and clears the mark a previous document left, if any: set means that document went away mid-run. */
export function takeInflight(): Inflight | null {
  const raw = storage()?.getItem(INFLIGHT_KEY);
  if (!raw) return null;
  clearInflight();
  try {
    const mark = JSON.parse(raw) as Partial<Inflight>;
    return { engine: mark.engine === "webgpu" || mark.engine === "wasm" ? mark.engine : null, edge: typeof mark.edge === "number" ? mark.edge : LIMITS.maxEdge };
  } catch {
    return { engine: null, edge: LIMITS.maxEdge };
  }
}

/** The mark this document started with, and whether the visit was in low-memory mode already (a repeat). */
export type Crash = { mark: Inflight; repeat: boolean };

let crash: Crash | null | undefined;
const crashListeners = new Set<() => void>();

/**
 * The reload this document is recovering from, or null. Read once, on the first call: the
 * mark is taken and low-memory mode is switched on then. A store for `useSyncExternalStore`
 * (server snapshot null), so the note renders after hydration without a mismatch.
 */
export function crashedRun(): Crash | null {
  if (crash === undefined) {
    const mark = takeInflight();
    if (mark) {
      crash = { mark, repeat: lowMemory() };
      setLowMemory();
    } else {
      crash = null;
    }
  }
  return crash;
}

export function dismissCrash(): void {
  crash = null;
  for (const listener of crashListeners) listener();
}

export function subscribeCrash(listener: () => void): () => void {
  crashListeners.add(listener);
  return () => {
    crashListeners.delete(listener);
  };
}
