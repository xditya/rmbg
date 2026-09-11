/**
 * The page side of the model cache (`public/sw.js`): registering the worker, waiting for it
 * to take the page over before the first model fetch, and asking the browser to keep the
 * storage. Browser only.
 */

import { MODEL_BASE_URL } from "@/lib/config";

/** How long the first model fetch waits for a freshly registered worker to claim the page. */
const CLAIM_WAIT_MS = 3000;

let registration: Promise<boolean> | undefined;

/**
 * Registers the worker once, after the page has loaded (it is small, but the first paint comes
 * first). The base URL travels in the query string, so a build with a different mirror gets
 * a fresh worker. Resolves with whether a worker is registered; never rejects.
 */
export function registerModelCache(): Promise<boolean> {
  registration ??= (async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    if (document.readyState !== "complete") await new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
    try {
      await navigator.serviceWorker.register(`/sw.js?base=${encodeURIComponent(MODEL_BASE_URL)}`);
      return true;
    } catch {
      return false;
    }
  })();
  return registration;
}

let claimed: Promise<void> | undefined;

/**
 * Resolves once the worker controls this document, so the fetches that follow go through
 * its cache: at once on every visit after the first, and on the first after a short wait
 * for the new worker to activate and claim the page (capped, so a browser that never
 * controls, or a hard reload, does not hold the model up).
 */
export function modelCacheReady(): Promise<void> {
  claimed ??= (async () => {
    if (!(await registerModelCache())) return;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLAIM_WAIT_MS);
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  })();
  return claimed;
}

let persistAsked = false;

/** Asks once for persistent storage, so Safari and Chrome do not evict the cache under pressure. Best effort. */
export function requestPersistentStorage(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* no storage manager */
  }
}
