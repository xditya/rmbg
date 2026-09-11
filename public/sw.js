/*
 * rmbg's model cache. A service worker with one job: keep the model and runtime chunks the
 * page fetches from the weights CDN in Cache Storage, so both engines' files stay on the
 * device once downloaded (the CDN sends no Cache-Control, and the HTTP cache evicts 88 MB
 * files at will). Nothing else is touched: no app shell, no offline page.
 *
 * The base URL comes from the page at registration time (`/sw.js?base=<encoded>`, see
 * src/lib/model-cache.ts), since a worker cannot read the app's environment; without it the
 * allowlist is imgly's CDN. Only GET requests under that base are looked at:
 *   - a last path segment of 64 hex characters is a content-addressed chunk: cache first, and
 *     on a miss fetched with CORS; the body is stored, then hashed, and dropped again unless
 *     its sha256 is the name, so a truncated or tampered download is served once but not kept;
 *   - resources.json, the manifest, is network first with the cached copy as the fallback.
 * When Cache Storage itself fails, the request simply goes to the network (see below).
 * Plain JS, no bundler: Next serves it from /public as it is.
 */

const CACHE = "rmbg-models-v1";
const DEFAULT_BASE = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";
const CHUNK = /^[0-9a-f]{64}$/;

const BASE = (() => {
  try {
    const given = new URL(self.location.href).searchParams.get("base");
    if (!given) return DEFAULT_BASE;
    const url = new URL(given).href;
    return url.endsWith("/") ? url : `${url}/`;
  } catch {
    return DEFAULT_BASE;
  }
})();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("rmbg-models-") && key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/** What a request is to this worker: a chunk, the manifest, or not ours (null). The cache key drops any query string. */
function classify(request) {
  if (request.method !== "GET" || !request.url.startsWith(BASE)) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const key = url.origin + path;
  if (CHUNK.test(name)) return { kind: "chunk", name, key };
  if (name === "resources.json") return { kind: "manifest", key };
  return null;
}

self.addEventListener("fetch", (event) => {
  const hit = classify(event.request);
  if (!hit) return;
  event.respondWith(hit.kind === "chunk" ? chunk(event, hit) : manifest(event, hit));
});

/*
 * Cache Storage can refuse to open or read (a damaged profile, storage blocked by policy
 * while the worker still runs, a quota state). None of that may cost the page its download:
 * every cache call below is guarded, and whenever the cache is unusable the request goes to
 * the network as if there were no worker. The worker can only ever add a cache.
 */

/** The cache, or null when it cannot be opened. */
async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

/** `cache.match` that answers undefined instead of throwing. */
async function lookup(cache, key) {
  try {
    return await cache.match(key);
  } catch {
    return undefined;
  }
}

async function chunk(event, { name, key }) {
  const cache = await openCache();
  if (!cache) return fetch(event.request);
  const cached = await lookup(cache, key);
  if (cached) return cached;
  const response = await fetch(key, { mode: "cors" });
  if (response.ok && response.type !== "opaque") event.waitUntil(keep(cache, key, name, response.clone()));
  return response;
}

/*
 * The library asks for every chunk of a file at once (22 x 4 MB on WebGPU), so the checking
 * is done one chunk at a time: the clone is streamed into the cache as it arrives, which
 * holds no copy in memory, and the entries are then read back and hashed in turn (one 4 MB
 * buffer at a time) with any whose sha256 is not their name deleted. For the moment between
 * the store and its check a wrong chunk could be served from the cache; the download the
 * page is doing already has those bytes, and the entry is gone before the next run.
 */
let checking = Promise.resolve();

/** Stores a chunk, then queues its check. Storage trouble (quota, a body cut short) leaves nothing behind. */
async function keep(cache, key, name, response) {
  try {
    await cache.put(key, response);
  } catch {
    return;
  }
  const turn = checking.then(() => verify(cache, key, name));
  checking = turn.catch(() => {});
  await checking;
}

/** Hashes the stored chunk; a mismatch, or a read that fails, removes it. */
async function verify(cache, key, name) {
  try {
    const stored = await cache.match(key);
    if (!stored) return;
    const digest = await crypto.subtle.digest("SHA-256", await stored.arrayBuffer());
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    if (hex === name) return;
  } catch {
    /* unreadable: treated like a mismatch */
  }
  await cache.delete(key).catch(() => {});
}

async function manifest(event, { key }) {
  const cache = await openCache();
  if (!cache) return fetch(event.request);
  try {
    const response = await fetch(key, { mode: "cors" });
    if (response.ok && response.type !== "opaque") {
      event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
      return response;
    }
    return (await lookup(cache, key)) || response;
  } catch (error) {
    const cached = await lookup(cache, key);
    if (cached) return cached;
    throw error;
  }
}
