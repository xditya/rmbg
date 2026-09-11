/**
 * End-to-end smoke test: boots the production server, screenshots the empty and result states
 * at phone / tablet / desktop widths in both themes, runs one real image through the model
 * (WebAssembly in headless Chromium) to check the cutout has a transparent border and an
 * opaque subject, exercises the engine picker (the two radios in More on the phone layout,
 * their touch targets, the desktop control after a reload, `?engine=wasm`), the `canRedo`
 * decision behind "Redo this photo" and the mask judge behind the WebGPU self-check, the model
 * cache (the service worker, its Cache Storage bucket, the picker's badges, a photo finished
 * with the weights origin blocked), the colour picker, the crash guard and the decode path
 * (a 3000x2000 photo fitted to 2,048 px, a JPEG with EXIF rotation), checks the headers of
 * the frame the page runs WebGPU in, screenshots the docs page, and exercises the HTTP API
 * (POST /api/v1/remove, GET /api/v1/info) against the same server. The 429 check needs the
 * default rate limit, so it spawns one extra short-lived server on PORT + 1 with the limiter
 * at its default.
 *
 *   pnpm e2e
 *
 * Environment: PORT (default 3111), SHOTS (screenshot directory), E2E_TIMEOUT_MS (model wait,
 * default 4 minutes), HTTPS_PROXY (forwarded to Chromium so the model CDN is reachable behind
 * an egress proxy), E2E_CDN_CACHE (where the weights are kept between runs, see `startMirror`;
 * `0` turns the cache and the mirror off), E2E_WEBGPU=1 (turns on Chromium's software WebGPU
 * adapter: detection must still pick WebAssembly, since it has no shader-f16, and a page whose
 * adapter is made to claim the feature must be caught by the self-check and fall back). Never
 * runs `playwright install`: it uses whatever Chromium Playwright resolves from
 * PLAYWRIGHT_BROWSERS_PATH.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3111);
const BASE = `http://localhost:${PORT}`;
/** The second server, with the default per-IP limit, for the 429 check. */
const LIMIT_PORT = PORT + 1;
const LIMIT_BASE = `http://localhost:${LIMIT_PORT}`;
const SHOTS = resolve(process.env.SHOTS ?? resolve(ROOT, "e2e/screens"));
const MODEL_TIMEOUT = Number(process.env.E2E_TIMEOUT_MS ?? 4 * 60 * 1000);
/**
 * The build this script makes and serves. Its own directory: the weights URL is inlined at
 * build time and points at the mirror here, so building into `.next` would leave `pnpm start`
 * and a deploy with a mirror that is gone (and a CSP that blocks the CDN).
 */
const DIST = process.env.NEXT_DIST_DIR || ".next-e2e";
/** The library's default publicPath: where the weights and the runtime come from. */
const CDN = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";
const CDN_CACHE = process.env.E2E_CDN_CACHE === "0" ? null : resolve(process.env.E2E_CDN_CACHE ?? resolve(tmpdir(), "rmbg-e2e-cdn"));
/** The local mirror of the CDN (see `startMirror`), and the base URL the app is built and started with. */
const MIRROR_PORT = PORT + 2;
const MODEL_BASE = CDN_CACHE ? `http://127.0.0.1:${MIRROR_PORT}/` : CDN;
/** The Cache Storage bucket the service worker keeps the chunks in (public/sw.js). */
const MODEL_CACHE = "rmbg-models-v1";
/** The long edge the crash guard fits photos to (LOW_MEMORY_EDGE in src/lib/config.ts). */
const LOW_MEMORY_EDGE = 2048;

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];

mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const pass = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};
const check = (ok, msg) => (ok ? pass(msg) : fail(msg));

/* ---------------------------------------------------------------- server */

async function isUp(base = BASE) {
  try {
    const r = await fetch(`${base}/`, { redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

// Run Next's bin directly under this node: killing the child then really stops the server.
// Going through `pnpm start` leaves an orphaned next-server holding the port after cleanup.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

/** Whether a file under `dir` contains `text`: the build carries the weights URL as a literal. */
function treeHas(dir, text) {
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) {
      if (treeHas(path, text)) return true;
    } else if (/\.js$/.test(name) && readFileSync(path, "utf8").includes(text)) return true;
  }
  return false;
}

/** The newest mtime under `dir`, for the staleness check. */
function newest(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = 0;
  for (const name of readdirSync(path)) t = Math.max(t, newest(resolve(path, name)));
  return t;
}

/**
 * The weights URL is inlined at build time (NEXT_PUBLIC_MODEL_URL), so the build in `DIST` must
 * carry the one this run uses: the mirror's, or the CDN's without the cache. Rebuilds when it
 * does not, or when a source file is newer than the build. `next build` rewrites next-env.d.ts
 * and tsconfig.json to point at its dist directory; both are put back, so the tree stays clean
 * and `pnpm typecheck` keeps reading `.next`.
 */
async function ensureBuild() {
  const built = existsSync(resolve(ROOT, DIST, "BUILD_ID")) ? statSync(resolve(ROOT, DIST, "BUILD_ID")).mtimeMs : 0;
  const sources = Math.max(...["src", "public", "next.config.ts", "package.json"].map((f) => newest(resolve(ROOT, f))));
  if (treeHas(resolve(ROOT, DIST, "static/chunks"), MODEL_BASE) && built > sources) return;
  console.log(`info building ${DIST} with NEXT_PUBLIC_MODEL_URL=${MODEL_BASE}${built > sources ? "" : " (the source is newer than the build)"}`);
  const t0 = Date.now();
  const kept = ["next-env.d.ts", "tsconfig.json"].map((name) => resolve(ROOT, name)).filter((file) => existsSync(file)).map((file) => [file, readFileSync(file, "utf8")]);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [nextBin, "build"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NEXT_PUBLIC_MODEL_URL: MODEL_BASE, NEXT_DIST_DIR: DIST } });
    child.on("exit", done);
  });
  for (const [file, before] of kept) if (readFileSync(file, "utf8") !== before) writeFileSync(file, before);
  if (code !== 0) throw new Error(`next build exited with ${code}`);
  console.log(`info built in ${Math.round((Date.now() - t0) / 1000)}s`);
}

/** Boots `next start` on `port` with the given extra environment and waits for it. */
async function startServer(port, env) {
  console.log(`info starting next start on :${port}`);
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...env, NEXT_PUBLIC_MODEL_URL: MODEL_BASE, NEXT_DIST_DIR: DIST } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    if (await isUp(base)) return child;
    if (child.exitCode !== null) throw new Error(`server on :${port} exited with ${child.exitCode}`);
    await sleep(500);
  }
  child.kill();
  throw new Error(`server on :${port} did not come up in 60s`);
}

let server = null;
let limitServer = null;
async function ensureServer() {
  if (await isUp()) {
    console.log(`info reusing server on ${BASE} (its rate limit is whatever it was started with; it must serve a build made with NEXT_PUBLIC_MODEL_URL=${MODEL_BASE})`);
    return;
  }
  await ensureBuild();
  // A high limit for the functional checks; the 429 check gets its own server with the default.
  server = await startServer(PORT, { ...process.env, RATE_LIMIT_PER_MIN: "1000" });
}

/* ---------------------------------------------------------------- mirror */

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isChunk = (name) => /^[0-9a-f]{64}$/.test(name);

/** The mirror while it runs: its server, its counters, and `blocked`, which makes it answer 503 to everything. */
let mirror = null;

/**
 * The model CDN, mirrored on 127.0.0.1 from a cache on disk between runs. Every context is a
 * fresh profile with an empty HTTP cache and no service worker, so without this each of the
 * half-dozen contexts that run the model would fetch the weights again (55 MB on WebAssembly,
 * 111 MB more on the spoofed WebGPU pass), which is what made the runs time out on a slow
 * link. Earlier runs served the on-disk chunks through Playwright's request interception;
 * that only sees requests the page makes, and the service worker's own fetches (the ones that
 * fill its cache) go straight to the network, so the mirror is what both of them reach. The
 * chunks are content-addressed (the file name is the sha256 of the bytes), so a cached chunk
 * is only served when it still checks out and a fetched one is only kept when it does;
 * resources.json is fetched from the CDN once per run (the disk copy is the fallback). CORS
 * is open, as on the CDN: the page and the worker fetch cross-origin.
 */
async function startMirror() {
  if (!CDN_CACHE) return null;
  mkdirSync(CDN_CACHE, { recursive: true });
  const stats = { hits: 0, misses: 0, blockedChunks: 0, blockedManifests: 0 };
  const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const manifestFile = resolve(CDN_CACHE, "resources.json");
  let manifest = null;
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, MODEL_BASE).pathname.slice(1);
    const answer = (status, body = null, type = "application/octet-stream") => {
      res.writeHead(status, body ? { ...cors, "Content-Type": type, "Content-Length": body.length } : cors);
      res.end(body ?? undefined);
    };
    if (req.method !== "GET") return answer(405);
    if (mirror?.blocked) {
      if (isChunk(name)) stats.blockedChunks++;
      else stats.blockedManifests++;
      return answer(503);
    }
    try {
      if (name === "resources.json") {
        if (!manifest) {
          try {
            const r = await fetch(`${CDN}resources.json`);
            if (r.ok) {
              manifest = Buffer.from(await r.arrayBuffer());
              writeFileSync(manifestFile, manifest);
            }
          } catch {}
          manifest ??= existsSync(manifestFile) ? readFileSync(manifestFile) : null;
        }
        return manifest ? answer(200, manifest, "application/json") : answer(502);
      }
      if (!isChunk(name)) return answer(404);
      const file = resolve(CDN_CACHE, name);
      let body = existsSync(file) ? readFileSync(file) : null;
      if (body && sha256(body) === name) stats.hits++;
      else {
        const r = await fetch(`${CDN}${name}`);
        if (!r.ok) return answer(r.status);
        body = Buffer.from(await r.arrayBuffer());
        if (sha256(body) !== name) return answer(502);
        writeFileSync(file, body);
        stats.misses++;
      }
      return answer(200, body);
    } catch (e) {
      console.log(`info mirror: ${name.slice(0, 12)} failed (${String(e).split("\n")[0]})`);
      return answer(502);
    }
  });
  await new Promise((ready) => server.listen(MIRROR_PORT, "127.0.0.1", ready));
  console.log(`info model mirror on ${MODEL_BASE} from ${CDN_CACHE}`);
  return { server, stats, blocked: false };
}

/** The chunk URLs an engine's files are made of, from the manifest the app reads (through the mirror when there is one). */
async function chunkUrls(keys) {
  const manifest = await (await fetch(`${MODEL_BASE}resources.json`)).json();
  return keys.flatMap((key) => (manifest[key]?.chunks ?? []).map((c) => `${MODEL_BASE}${c.name}`));
}

const WASM_FILES = ["/models/isnet_quint8", "/onnxruntime-web/ort-wasm-simd-threaded.wasm", "/onnxruntime-web/ort-wasm-simd-threaded.mjs"];

/* --------------------------------------------------------------- browser */

function launchOptions() {
  // Headless Chromium has no usable WebGPU adapter, so the run exercises the WebAssembly path.
  // E2E_WEBGPU=1 turns on the software adapter to exercise the WebGPU -> WebAssembly fallback too.
  const opts = { args: process.env.E2E_WEBGPU ? ["--enable-unsafe-webgpu"] : [] };
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    opts.proxy = { server: proxy, bypass: "localhost,127.0.0.1" };
    // A TLS-re-terminating egress proxy can choke on Chromium's TLS 1.3 ClientHello (the tunnel
    // drops mid-handshake); capping at 1.2 keeps certificate verification on and the CDN reachable.
    opts.args.push("--ssl-version-max=tls1.2");
  }
  return opts;
}

/**
 * Playwright's default resolution first. When the installed client wants a newer build than the
 * one on disk (we never run `playwright install`), fall back to any full Chromium build found
 * under PLAYWRIGHT_BROWSERS_PATH.
 */
async function launch() {
  const opts = launchOptions();
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!/Executable doesn't exist/.test(String(e))) throw e;
    const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
    const builds = existsSync(dir) ? readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
    for (const b of builds.reverse()) {
      const exe = resolve(dir, b, "chrome-linux", "chrome");
      if (existsSync(exe)) {
        console.log(`info using ${exe}`);
        return chromium.launch({ ...opts, executablePath: exe });
      }
    }
    throw e;
  }
}

/** A fresh context with the theme decided before the first paint (the ThemeScript reads localStorage); `touch` emulates a touch screen (`pointer: coarse`). */
async function newContext(browser, { width, height, theme, touch = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, hasTouch: touch });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
  }, theme);
  return ctx;
}

const problems = [];
/** `quiet` keeps console errors out of the report: the spoofed-WebGPU page raises hundreds of expected validation errors. */
function watch(page, label, { quiet = false } = {}) {
  page.on("pageerror", (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (/Content Security Policy|CSP/i.test(m.text()) || (m.type() === "error" && !quiet)) problems.push(`${label} console.${m.type()}: ${m.text()}`);
  });
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED/.test(f)) problems.push(`${label} requestfailed: ${r.url()} ${f}`);
  });
}

async function layoutFacts(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const bar = document.querySelector('nav[aria-label="Photo actions"]');
    const visible = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
    return {
      overflowX: doc.scrollWidth > doc.clientWidth,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dark: doc.classList.contains("dark"),
      barVisible: visible(bar),
      barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
      innerHeight: innerHeight,
      pick: !!document.querySelector("#pick"),
      title: document.title,
    };
  });
}

/* ------------------------------------------------------------ test image */

/**
 * A shaded ball on a dark wall, drawn in-page so no fixture file is needed. The model is
 * trained on photographs: a flat disc on a pale gradient leaves it unsure and the mask comes
 * back hazy on both engines, while a lit sphere with a ground shadow is cut cleanly.
 * 800x600 by default; with `size` the same picture is scaled into a square, which is what the
 * app's WebGPU self-check draws (`drawSelfCheckImage` in src/lib/remove.ts, 256).
 */
async function makeTestPng(page, size = null) {
  const dataUrl = await page.evaluate((size) => {
    const c = document.createElement("canvas");
    c.width = size ?? 800;
    c.height = size ?? 600;
    const ctx = c.getContext("2d");
    if (size) {
      const s = size / 600;
      ctx.translate((size - 800 * s) / 2, 0);
      ctx.scale(s, s);
    }
    const wall = ctx.createLinearGradient(0, 0, 0, 600);
    wall.addColorStop(0, "#343a42");
    wall.addColorStop(1, "#22262c");
    ctx.fillStyle = wall;
    ctx.fillRect(-200, 0, 1200, 600);
    // a soft shadow on the ground under the ball
    ctx.save();
    ctx.translate(410, 550);
    ctx.scale(1, 0.18);
    const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 216);
    shadow.addColorStop(0, "rgba(0,0,0,.45)");
    shadow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(0, 0, 216, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // subject: a ball lit from the upper left, with a specular highlight
    const ball = ctx.createRadialGradient(328, 204, 0, 328, 204, 384);
    ball.addColorStop(0, "#ffb86b");
    ball.addColorStop(0.5, "#c2410c");
    ball.addColorStop(1, "#4a1506");
    ctx.fillStyle = ball;
    ctx.beginPath();
    ctx.arc(400, 300, 240, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.beginPath();
    ctx.ellipse(340, 230, 45, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    return c.toDataURL("image/png");
  }, size);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/* -------------------------------------------------------------- mask check */

/**
 * The app's pure mask judge (src/lib/mask-check.ts), run under plain node: the file has no
 * imports and only bare `: number`-style annotations, so a small regex turns it into JavaScript.
 */
async function loadMaskCheck() {
  const ts = readFileSync(resolve(ROOT, "src/lib/mask-check.ts"), "utf8");
  const js = ts.replace(/^export type .*$/gm, "").replace(/: (Uint8ClampedArray|MaskStats|number|boolean)\b/g, "");
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

/**
 * `canRedo` from engine-picker.tsx, on its own: the function is plain JS once its signature's
 * types go, and the rest of the file (React, the icons) is not needed to judge it.
 */
async function loadCanRedo() {
  const src = readFileSync(resolve(ROOT, "src/components/remover/engine-picker.tsx"), "utf8");
  const start = src.indexOf("export function canRedo(");
  const end = src.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("canRedo not found in engine-picker.tsx");
  const fn = src.slice(start, end + 2);
  const body = fn.indexOf("{");
  const js = "export function canRedo(card, preference, detected) " + fn.slice(body);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

/**
 * The Redo decision on every combination that matters: the preference against the engine the
 * photo ran on, with detection deciding whether "Automatic" would change anything, and no
 * Redo at all for a photo that is still running.
 */
function canRedoUnit({ canRedo }) {
  const cases = [
    { name: "processor only after a graphics-chip cut", card: { state: "done", engine: "webgpu" }, preference: "wasm", detected: "webgpu", expect: true },
    { name: "automatic after a processor cut, chip available", card: { state: "done", engine: "wasm" }, preference: "auto", detected: "webgpu", expect: true },
    { name: "processor only after a processor cut", card: { state: "done", engine: "wasm" }, preference: "wasm", detected: "wasm", expect: false },
    { name: "automatic after a graphics-chip cut", card: { state: "done", engine: "webgpu" }, preference: "auto", detected: "webgpu", expect: false },
    { name: "automatic after a processor cut, no chip", card: { state: "done", engine: "wasm" }, preference: "auto", detected: "wasm", expect: false },
    { name: "automatic after a processor cut, detection pending", card: { state: "done", engine: "wasm" }, preference: "auto", detected: null, expect: false },
    { name: "a photo still removing", card: { state: "removing", engine: "webgpu" }, preference: "wasm", detected: "webgpu", expect: false },
    { name: "a queued photo", card: { state: "queued" }, preference: "wasm", detected: "webgpu", expect: false },
    { name: "no photo", card: null, preference: "wasm", detected: "webgpu", expect: false },
  ];
  for (const c of cases) check(canRedo(c.card, c.preference, c.detected) === c.expect, `canRedo(${c.name}) is ${c.expect}`);
}

/** A synthetic 256x256 RGBA mask: opaque inside a centred disc of `radius`, clear outside; `flat` fills everything with one alpha. */
function syntheticMask({ radius = 0, flat = null } = {}) {
  const size = 256;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - size / 2, y - size / 2) <= radius;
      const a = flat ?? (inside ? 255 : 0);
      rgba.set([194, 65, 12, a], (y * size + x) * 4);
    }
  }
  return { rgba, size };
}

const fmtStats = (s) => `centre ${s.centre.toFixed(1)} corners ${s.corners.toFixed(1)} ring ${s.ring.toFixed(1)} allEqual ${s.allEqual}`;

/** The judge on three masks it must get right: a clean ball, an all-transparent one (what a wrong WebGPU run gives) and an all-opaque one. */
function maskCheckUnit({ maskLooksSane, maskStats }) {
  const cases = [
    { name: "ball", expect: true, ...syntheticMask({ radius: 100 }) },
    { name: "all-transparent", expect: false, ...syntheticMask({ flat: 0 }) },
    { name: "all-opaque", expect: false, ...syntheticMask({ flat: 255 }) },
  ];
  for (const c of cases) {
    const ok = maskLooksSane(c.rgba, c.size, c.size);
    check(ok === c.expect, `maskLooksSane(${c.name}) is ${c.expect} (${fmtStats(maskStats(c.rgba, c.size, c.size))})`);
  }
}

/* ---------------------------------------------------------------- helpers */

const DONE = "img[alt$=', background removed']";

/** Collects toast texts while `work` runs: toasts dismiss themselves after about three seconds, so they are polled. */
async function withToasts(page, work) {
  const seen = new Set();
  let running = true;
  const poll = (async () => {
    while (running) {
      try {
        for (const t of await page.evaluate(() => Array.from(document.querySelectorAll('[role="status"]')).map((e) => e.textContent?.trim() ?? ""))) seen.add(t);
      } catch {}
      await sleep(150);
    }
  })();
  try {
    return { result: await work(), toasts: [...seen] };
  } finally {
    running = false;
    await poll;
  }
}

/** The engine caption under the photo (the visible one: phones and wider layouts render different rows): its text, the engine it names, its tooltip. */
const engineCaption = (page) =>
  page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("span[data-engine]")).find((e) => e.getClientRects().length > 0);
    return b ? { label: b.textContent?.trim() ?? "", engine: b.getAttribute("data-engine"), tooltip: b.getAttribute("title"), isButton: b.tagName === "BUTTON" || !!b.closest("button") } : null;
  });

/** The visible engine radiogroup (the More sheet's list, the desktop column's or the tablet toolbar's segmented control), its radios and the hint under it. */
const enginePicker = (page) =>
  page.evaluate(() => {
    const group = Array.from(document.querySelectorAll('[role="radiogroup"][aria-labelledby]')).find((g) => g.querySelector("[data-engine-option]") && g.getClientRects().length > 0);
    if (!group) return null;
    const label = document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? "";
    const radios = Array.from(group.querySelectorAll('[role="radio"]')).map((r) => {
      const rect = r.getBoundingClientRect();
      const spans = Array.from(r.querySelectorAll(":scope > span > span")).map((e) => e.textContent?.trim() ?? "");
      const badge = r.querySelector("[data-model-status]");
      return {
        option: r.getAttribute("data-engine-option"),
        name: spans.length >= 1 ? spans[0] : (r.textContent?.trim() ?? ""),
        description: r.querySelector("[data-engine-hint]")?.textContent?.trim() ?? "",
        badge: badge ? { status: badge.getAttribute("data-model-status"), text: badge.textContent?.trim() ?? "" } : null,
        checked: r.getAttribute("aria-checked"),
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height },
      };
    });
    const hintEl = group.nextElementSibling?.tagName === "P" ? group.nextElementSibling : null;
    const hint = hintEl ? (hintEl.querySelector("[data-engine-hint]")?.textContent?.trim() ?? "") : null;
    const hintBadge = hintEl?.querySelector("[data-model-status]");
    const badge = hintBadge ? { status: hintBadge.getAttribute("data-model-status"), text: hintBadge.textContent?.trim() ?? "" } : null;
    const redo = Array.from(document.querySelectorAll("button")).some((b) => /^Redo this photo$/.test(b.textContent?.trim() ?? "") && b.getClientRects().length > 0);
    return { label, radios, hint, badge, redo };
  });

/** The right side of the visible caption under the photo: name (wider layouts), dimensions and time. */
const captionRight = (page) =>
  page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("span[data-engine]")).find((e) => e.getClientRects().length > 0);
    return b?.nextElementSibling?.textContent?.trim() ?? null;
  });

/** The texts in the polite live region right now. */
const liveTexts = (page) => page.evaluate(() => Array.from(document.querySelectorAll('[aria-live="polite"] span')).map((e) => e.textContent?.trim() ?? ""));

/** Straight RGBA of the cutout on the stage, as a plain array (the page cannot hand a typed array over). */
const resultRgba = (page) =>
  page.evaluate(async () => {
    const img = document.querySelector("img[alt$=', background removed']");
    const bmp = await createImageBitmap(await (await fetch(img.src)).blob());
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) };
  });

/** Alpha over the outer 8 px of the image: the mean says whether the background is really clear, the max catches a stray blob. */
function ringStats(alphaAt, w, h) {
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 8 || y < 8 || x >= w - 8 || y >= h - 8) {
        const a = alphaAt(x, y);
        if (a > max) max = a;
        sum += a;
        n++;
      }
    }
  }
  return { max, mean: sum / n };
}

/* ------------------------------------------------------------------ run */

async function shootEmpty(browser) {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const label = `${vp.name}-${theme}-empty`;
      const ctx = await newContext(browser, { ...vp, theme });
      const page = await ctx.newPage();
      watch(page, label);
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.waitForSelector("#pick");
      await page.screenshot({ path: `${SHOTS}/${label}.png` });
      const facts = await layoutFacts(page);
      check(!facts.overflowX, `${label}: no horizontal overflow (${facts.scrollWidth}/${facts.clientWidth})`);
      check(facts.dark === (theme === "dark"), `${label}: theme applied`);
      await ctx.close();
    }
  }
}

async function runModel(browser) {
  const vp = VIEWPORTS[2];
  const ctx = await newContext(browser, { ...vp, theme: "light" });
  const page = await ctx.newPage();
  watch(page, "model");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const png = await makeTestPng(page);
  check(png.length > 1000, `test image generated (${png.length} bytes)`);

  const t0 = Date.now();
  await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector("img[alt='disc.png']", { timeout: 10_000 });
  pass("card added and stage shown");

  // Watch the status line while we wait, so a hang is diagnosable.
  const status = async () => {
    try {
      return await page.evaluate(() => {
        const t = document.querySelector('nav[aria-label="Photo actions"]');
        const lines = Array.from(document.querySelectorAll("span, p")).map((e) => e.textContent?.trim() ?? "");
        return { title: document.title, status: lines.filter((l) => /downloading|removing|failed|Processor|Graphics chip|queued|waiting/i.test(l)).slice(0, 4), bar: !!t };
      });
    } catch {
      return null;
    }
  };

  let done = false;
  let last = "";
  while (Date.now() - t0 < MODEL_TIMEOUT) {
    const s = await page.evaluate(() => ({
      done: !!document.querySelector("img[alt$=', background removed']"),
      failed: !!document.querySelector('[role="alert"]'),
    }));
    if (s.done) {
      done = true;
      break;
    }
    if (s.failed) break;
    const st = JSON.stringify(await status());
    if (st !== last) {
      console.log(`info ${Math.round((Date.now() - t0) / 1000)}s ${st}`);
      last = st;
    }
    await sleep(1500);
  }
  check(done, `result reached done state in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (!done) {
    await page.screenshot({ path: `${SHOTS}/model-failed.png` });
    const text = await page.evaluate(() => document.body.innerText);
    console.log("info page text:\n" + text);
    await ctx.close();
    return null;
  }

  // Let the reveal cross-fade finish before the pixel check and the screenshots.
  await sleep(600);

  const pixels = await page.evaluate(async () => {
    const img = document.querySelector("img[alt$=', background removed']");
    const blob = await (await fetch(img.src)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    const w = bmp.width;
    const h = bmp.height;
    const all = ctx.getImageData(0, 0, w, h).data;
    let ringMax = 0;
    let ringSum = 0;
    let ringN = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < 8 || y < 8 || x >= w - 8 || y >= h - 8) {
          const a = all[(y * w + x) * 4 + 3];
          if (a > ringMax) ringMax = a;
          ringSum += a;
          ringN++;
        }
      }
    }
    return {
      width: w,
      height: h,
      corners: [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)],
      centre: at(Math.round(w / 2), Math.round(h / 2)),
      ring: { max: ringMax, mean: ringSum / ringN },
      engine: Array.from(document.querySelectorAll("span[data-engine]")).find((e) => e.getClientRects().length > 0)?.textContent?.trim() ?? null,
    };
  });
  console.log(`info result ${pixels.width}x${pixels.height} engine=${pixels.engine} corners=${JSON.stringify(pixels.corners.map((c) => c[3]))} centre=${JSON.stringify(pixels.centre)} ring max ${pixels.ring.max} mean ${pixels.ring.mean.toFixed(2)}`);
  check(pixels.width === 800 && pixels.height === 600, "result keeps the input size");
  check(pixels.corners.every((c) => c[3] === 0), "corners are transparent (alpha 0)");
  check(pixels.ring.mean < 1 && pixels.ring.max <= 64, `border is clear (alpha mean ${pixels.ring.mean.toFixed(2)}, max ${pixels.ring.max})`);
  check(pixels.centre[3] >= 250, `centre is opaque (alpha ${pixels.centre[3]})`);
  // Chromium's software adapter (E2E_WEBGPU) has no shader-f16, so detection must land on WebAssembly there.
  if (process.env.E2E_WEBGPU) check(pixels.engine === "Processor", `engine caption reads Processor on the software adapter (${pixels.engine})`);
  else check(pixels.engine === "Processor" || pixels.engine === "Graphics chip", `engine caption shown (${pixels.engine})`);
  const caption = await engineCaption(page);
  check(caption !== null && !caption.isButton && /^Cut on your (processor|graphics chip)/.test(caption.tooltip ?? ""), `engine caption is plain text with a tooltip (${caption?.tooltip})`);

  await modelCachePass(ctx, page, png);
  await ctx.close();
  return png;
}

/**
 * The model cache, on the page that just ran the model: the service worker controls it, its
 * bucket holds every chunk of the WebAssembly model (the worker hashes each one after handing
 * it to the page, so the last may land a moment after the cut), and the picker's badges say
 * so: "Downloaded" under Processor only, "About 105 MB, downloads once" under Automatic,
 * which describes the graphics-chip model on every device, headless included. Then a fresh
 * page in the same context, with the weights origin blocked both ways (Playwright aborts what
 * the page asks for, the mirror answers 503 to the worker), finishes a photo from the cache.
 * The same context, not a fresh one: Cache Storage and the registration are per profile.
 */
async function modelCachePass(ctx, page, png) {
  const label = (s) => `model cache: ${s}`;
  const expected = await chunkUrls(WASM_FILES);
  check(expected.length > 0, label(`the manifest lists the WebAssembly files (${expected.length} chunks)`));
  let facts = null;
  for (let i = 0; i < 40; i++) {
    facts = await page.evaluate(
      async ({ urls, name }) => {
        const controller = !!navigator.serviceWorker?.controller;
        const keys = await caches.keys();
        const cache = await caches.open(name);
        let held = 0;
        for (const u of urls) if (await cache.match(u)) held++;
        const entries = (await cache.keys()).length;
        const persisted = (await navigator.storage?.persisted?.().catch(() => null)) ?? null;
        return { controller, keys, held, entries, persisted };
      },
      { urls: expected, name: MODEL_CACHE },
    );
    if (facts.controller && facts.held === expected.length) break;
    await sleep(250);
  }
  console.log(`info model cache ${JSON.stringify(facts)}`);
  check(facts.controller, label("the service worker controls the page"));
  check(facts.keys.includes(MODEL_CACHE), label(`caches.keys() includes ${MODEL_CACHE} (${facts.keys.join(", ") || "none"})`));
  check(facts.held === expected.length, label(`the cache holds every chunk of the WebAssembly model (${facts.held} of ${expected.length}; ${facts.entries} entries in all)`));

  // The badges, in More on the phone layout, where both options show at once.
  await page.setViewportSize(VIEWPORTS[0]);
  await sleep(300);
  await page.click('nav[aria-label="Photo actions"] button:has-text("More")');
  await page.waitForSelector("dialog[open]");
  let p = null;
  for (let i = 0; i < 25; i++) {
    p = await enginePicker(page);
    if (p?.radios.length === 2 && p.radios.every((r) => r.badge && r.badge.status !== "unknown")) break;
    await sleep(200);
  }
  const auto = p?.radios.find((r) => r.option === "auto");
  const wasm = p?.radios.find((r) => r.option === "wasm");
  check(wasm?.badge?.text === "Downloaded" && wasm.badge.status === "downloaded", label(`"Processor only" says Downloaded (${wasm?.badge?.text})`));
  check(auto?.badge?.text === "About 105 MB, downloads once" && auto.badge.status === "missing", label(`"Automatic" says "About 105 MB, downloads once" (${auto?.badge?.text})`));
  await page.screenshot({ path: `${SHOTS}/phone-more-badges.png` });
  await page.click('dialog[open] button:has-text("Done")');
  await sleep(300);

  // A fresh document (the library's session is gone with the old one) with the origin blocked.
  const blocked = await ctx.newPage();
  watch(blocked, "model-cache-blocked", { quiet: true });
  await blocked.route(`${MODEL_BASE}**`, (route) => route.abort());
  const before = mirror ? { ...mirror.stats } : null;
  if (mirror) mirror.blocked = true;
  try {
    await blocked.setViewportSize(VIEWPORTS[2]);
    await blocked.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const controlled = await blocked.evaluate(() => !!navigator.serviceWorker?.controller);
    check(controlled, label("the fresh page is controlled from the start"));
    await blocked.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
    const t0 = Date.now();
    let done = true;
    try {
      await blocked.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
    } catch {
      done = false;
    }
    check(done, label(`a photo reaches done with the weights origin blocked, in ${Math.round((Date.now() - t0) / 1000)}s`));
    if (!done) await blocked.screenshot({ path: `${SHOTS}/model-cache-blocked-failed.png` });
    if (mirror) {
      const chunks = mirror.stats.blockedChunks - before.blockedChunks;
      const manifests = mirror.stats.blockedManifests - before.blockedManifests;
      check(chunks === 0, label(`no chunk request reached the mirror while blocked (${chunks} chunks, ${manifests} manifest requests refused)`));
    }
    if (done) {
      const b = await engineCaption(blocked);
      check(b?.label === "Processor", label(`the caption reads Processor (${b?.label})`));
    }
  } finally {
    if (mirror) mirror.blocked = false;
    await blocked.close();
  }
}

/**
 * The colour picker. The custom swatch is a radio with the native colour input laid over it,
 * so what a finger or a pointer lands on at its centre is the input itself: the only way iOS
 * Safari opens its picker. A value set through the input (the native setter plus an `input`
 * event, which is what a picker dispatches) picks Custom and colours the swatch and the
 * result. Before the cut the input is disabled with the rest. Then at desktop width: the
 * same hit test, and the keyboard path, arrows along the radios to Custom and Space to open.
 */
async function colourPickerPass(browser, png) {
  const label = (s) => `colour picker: ${s}`;
  const ctx = await newContext(browser, { ...VIEWPORTS[0], theme: "light", touch: true });
  const page = await ctx.newPage();
  watch(page, "colour-picker");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector("img[alt='disc.png']", { timeout: 10_000 });
  const early = await page.evaluate(() => {
    const input = Array.from(document.querySelectorAll('input[type="color"]')).find((i) => i.getClientRects().length > 0);
    return input ? { disabled: input.disabled, done: !!document.querySelector("img[alt$=', background removed']") } : null;
  });
  check(early !== null && (early.disabled || early.done), label(`the input is disabled before the cut (disabled ${early?.disabled}, done ${early?.done})`));
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("photo reaches done state"));
    await ctx.close();
    return;
  }
  await sleep(500);

  const hit = () =>
    page.evaluate(() => {
      const swatch = Array.from(document.querySelectorAll('[role="radio"][data-kind="custom"]')).find((b) => b.getClientRects().length > 0);
      if (!swatch) return null;
      const r = swatch.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const el = document.elementFromPoint(x, y);
      const input = swatch.parentElement?.querySelector('input[type="color"]');
      return {
        tag: el?.tagName ?? null,
        type: el?.getAttribute("type") ?? null,
        isInput: !!input && el === input,
        disabled: input?.disabled ?? null,
        ariaHidden: input?.getAttribute("aria-hidden") ?? null,
        ariaLabel: input?.getAttribute("aria-label") ?? null,
        tabIndex: input?.tabIndex ?? null,
        cursor: input ? getComputedStyle(input).cursor : null,
        checked: swatch.getAttribute("aria-checked"),
        background: swatch.style.background,
        size: Math.round(r.width),
      };
    });
  const pickColour = (hex) =>
    page.evaluate((hex) => {
      const input = Array.from(document.querySelectorAll('input[type="color"]')).find((i) => i.getClientRects().length > 0);
      // The native setter, so React's value tracking sees the change and does not swallow the event.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, hex);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, hex);
  const stageColour = () =>
    page.evaluate(() => Array.from(document.querySelectorAll("div[style]")).find((d) => d.style.backgroundColor && d.getClientRects().length > 0)?.style.backgroundColor ?? null);

  let h = await hit();
  console.log(`info colour picker phone elementFromPoint ${JSON.stringify(h)}`);
  check(h?.isInput === true && h.type === "color", label(`phone: elementFromPoint at the centre of the Custom swatch is the input[type=color] (${h?.tag} type=${h?.type})`));
  check(h?.size >= 44, label(`phone: the swatch is ${h?.size}px`));
  check(
    h?.disabled === false && h.ariaHidden === null && h.ariaLabel === "Custom colour" && h.tabIndex === -1 && h.cursor === "pointer",
    label(`phone: the input is enabled, labelled "Custom colour", not aria-hidden, out of the tab order, cursor pointer (${JSON.stringify({ disabled: h?.disabled, ariaHidden: h?.ariaHidden, ariaLabel: h?.ariaLabel, tabIndex: h?.tabIndex, cursor: h?.cursor })})`),
  );
  check(h?.checked === "false", label("phone: Custom is not checked before a colour is picked"));
  await pickColour("#1e90ff");
  await sleep(250);
  h = await hit();
  const colour = await stageColour();
  check(h?.checked === "true", label(`phone: a value through the native input picks Custom (aria-checked ${h?.checked})`));
  check(h?.background === "rgb(30, 144, 255)", label(`phone: the swatch follows (${h?.background})`));
  check(colour === "rgb(30, 144, 255)", label(`phone: the result backdrop follows (${colour})`));
  await page.screenshot({ path: `${SHOTS}/phone-colour-picker.png` });

  // Desktop: the same hit test, then the keyboard path.
  await page.setViewportSize(VIEWPORTS[2]);
  await sleep(400);
  h = await hit();
  console.log(`info colour picker desktop elementFromPoint ${JSON.stringify(h)}`);
  check(h?.isInput === true && h.type === "color", label(`desktop: elementFromPoint at the centre of the Custom swatch is the input[type=color] (${h?.tag} type=${h?.type})`));
  await page.click('[role="radio"][data-kind="transparent"]:visible');
  await sleep(100);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-kind") ?? document.activeElement?.tagName ?? null);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await sleep(150);
  let f = await focused();
  check(f === "custom", label(`desktop: three arrows from Transparent land on Custom (${f})`));
  h = await hit();
  check(h?.checked === "true", label(`desktop: arriving by arrow picks the colour chosen before (aria-checked ${h?.checked}, ${h?.background})`));
  const errorsBefore = problems.filter((p) => /colour-picker pageerror/.test(p)).length;
  await page.keyboard.press("Space");
  await sleep(300);
  f = await focused();
  const errorsAfter = problems.filter((p) => /colour-picker pageerror/.test(p)).length;
  check(f === "custom" && errorsAfter === errorsBefore, label(`desktop: Space on Custom opens the picker without moving focus or throwing (focus ${f})`));
  await page.keyboard.press("Escape");
  await pickColour("#30a46c");
  await sleep(250);
  h = await hit();
  check(h?.checked === "true" && h.background === "rgb(48, 164, 108)" && (await stageColour()) === "rgb(48, 164, 108)", label(`desktop: a second colour reaches the swatch and the result (${h?.background})`));
  await page.screenshot({ path: `${SHOTS}/desktop-colour-picker.png` });
  await ctx.close();
}

/**
 * The crash guard and the decode path. A context whose sessionStorage says a cut was in
 * flight when the last document went away: the page starts with the note, switches the
 * visit to 2,048 px (a 3000x2000 photo is fitted to 2048x1365, the caption says so), still
 * makes thumbnails, and marks the job while it runs; started again with the flag already
 * set, the note also points at Processor only. Then a JPEG with EXIF orientation 6 on a
 * fresh page: the card reads the upright size without a full decode.
 */
async function memoryGuardPass(browser, png) {
  const label = (s) => `crash guard: ${s}`;
  const NOTE = `The page reloaded while cutting the last photo, which usually means it ran out of memory. Photos are now scaled to ${LOW_MEMORY_EDGE.toLocaleString("en-US")} px before the cut for this visit.`;
  const AGAIN = "If it keeps happening, pick Processor only under engine.";
  const ctx = await newContext(browser, { ...VIEWPORTS[0], theme: "light", touch: true });
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem("rmbg:inflight", JSON.stringify({ engine: "wasm", edge: 4096 }));
    } catch {}
  });
  const page = await ctx.newPage();
  watch(page, "crash-guard");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const notice = () => page.evaluate(() => document.querySelector('[role="alert"][data-notice="info"] p')?.textContent?.trim() ?? null);
  let text = await notice();
  console.log(`info crash notice: ${text}`);
  check(text === NOTE, label(`the note reads as written (${text})`));
  const flags = await page.evaluate(() => ({ low: sessionStorage.getItem("rmbg:low-memory"), inflight: sessionStorage.getItem("rmbg:inflight") }));
  check(flags.low === "1" && flags.inflight === null, label(`rmbg:low-memory is "1" and the mark is taken (${JSON.stringify(flags)})`));
  await page.screenshot({ path: `${SHOTS}/phone-crash-notice.png` });
  // Once more: the init script leaves the mark again, and the flag is already there.
  await page.reload({ waitUntil: "networkidle" });
  text = await notice();
  check(text === `${NOTE} ${AGAIN}`, label(`the second note adds the Processor only hint (${text})`));

  const big = await sharp(png).resize(3000, 2000).png().toBuffer();
  await page.setInputFiles("#pick", { name: "big.png", mimeType: "image/png", buffer: big });
  let marked = null;
  for (let i = 0; i < 50 && !marked; i++) {
    marked = await page.evaluate(() => sessionStorage.getItem("rmbg:inflight"));
    if (!marked) await sleep(100);
  }
  let mark = null;
  try {
    mark = JSON.parse(marked);
  } catch {}
  check(mark?.edge === LOW_MEMORY_EDGE, label(`the mark is set while the job runs, with the visit's edge (${marked})`));
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("the 3000x2000 photo reaches done state"));
    await page.screenshot({ path: `${SHOTS}/phone-crash-failed.png` });
    await ctx.close();
    return;
  }
  await sleep(600);
  const after = await page.evaluate(() => sessionStorage.getItem("rmbg:inflight"));
  check(after === null, label(`the mark is cleared once the job settles (${after})`));
  const caption = await captionRight(page);
  check(/^3,000 × 2,000 → 2,048 × 1,365/.test(caption ?? ""), label(`the caption reads 3,000 × 2,000 → 2,048 × 1,365 (${caption})`));
  const { width, height } = await resultRgba(page);
  check(width === 2048 && height === 1365, label(`the result is 2048x1365 (${width}x${height})`));
  const thumb = await page.evaluate(async () => {
    const original = document.querySelector("img[alt='big.png']")?.src ?? null;
    const swatch = Array.from(document.querySelectorAll('[role="radio"][data-kind="blur"] img')).find((i) => i.getClientRects().length > 0);
    if (!swatch) return null;
    const bmp = await createImageBitmap(await (await fetch(swatch.src)).blob());
    return { distinct: swatch.src !== original, width: bmp.width, height: bmp.height };
  });
  check(thumb?.distinct === true && Math.max(thumb.width, thumb.height) <= 320, label(`a thumbnail is still made (${thumb?.width}x${thumb?.height}, distinct from the original ${thumb?.distinct})`));
  await page.screenshot({ path: `${SHOTS}/phone-crash-result.png` });

  // A JPEG with EXIF orientation 6: 800x600 pixels shown upright as 600x800.
  const exifLabel = (s) => `exif: ${s}`;
  const exif = await sharp(png).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  const meta = await sharp(exif).metadata();
  check(meta.width === 800 && meta.height === 600 && meta.orientation === 6, exifLabel(`test JPEG is 800x600 with orientation 6 (${meta.width}x${meta.height}, ${meta.orientation})`));
  const page2 = await ctx.newPage();
  watch(page2, "exif");
  await page2.setViewportSize(VIEWPORTS[2]);
  await page2.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page2.setInputFiles("#pick", { name: "side.jpg", mimeType: "image/jpeg", buffer: exif });
  try {
    await page2.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(exifLabel("photo reaches done state"));
    await ctx.close();
    return;
  }
  await sleep(600);
  const dims = await page2.evaluate(() => document.querySelector("aside p.font-mono")?.textContent?.trim() ?? null);
  check(/^600 × 800/.test(dims ?? ""), exifLabel(`the card reads the upright size, 600 × 800 (${dims})`));
  const side = await captionRight(page2);
  const out = await resultRgba(page2);
  console.log(`info exif caption "${side}", result ${out.width}x${out.height}`);
  check(/600 × 800/.test(side ?? ""), exifLabel(`the caption reads 600 × 800 (${side})`));
  check(out.width === 600 && out.height === 800, exifLabel(`the cutout is upright too (${out.width}x${out.height})`));
  await ctx.close();
}

/**
 * The engine picker. On the phone layout it lives in More: two radios, "Automatic" and
 * "Processor only", each with its one-line description. Choosing "Processor only" moves the
 * disc, lands in localStorage, says so in the live region and shows no toast; the sheet stays
 * open. "Redo this photo" is not offered here: the photo ran on the processor, and choosing
 * "Processor only" changes nothing for it; nor after "Automatic", since detection lands on
 * the processor in headless Chromium. Then the same context at desktop width: the stored
 * choice is read at startup, the segmented control mirrors it, the next photo runs on the
 * processor, and choosing "Automatic" there flips the control, its hint and the storage.
 */
async function enginePickerPass(browser, png) {
  const label = (s) => `engine picker: ${s}`;
  const ctx = await newContext(browser, { ...VIEWPORTS[0], theme: "light" });
  const page = await ctx.newPage();
  watch(page, "engine-picker");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("photo reaches done state"));
    await ctx.close();
    return;
  }
  await sleep(300);
  check((await enginePicker(page)) === null, label("no engine control is visible on the phone layout before More opens"));
  await page.click('nav[aria-label="Photo actions"] button:has-text("More")');
  await page.waitForSelector("dialog[open]");
  await sleep(300);
  let p = await enginePicker(page);
  check(p?.label === "engine · applies to the next photo", label(`the sheet's group is labelled (${p?.label})`));
  check(p?.radios.length === 2, label(`two radios (${p?.radios.length})`));
  const auto = p?.radios.find((r) => r.option === "auto");
  const wasm = p?.radios.find((r) => r.option === "wasm");
  check(auto?.name === "Automatic" && auto.description === "Graphics chip when your device can do it, the fast way. Otherwise the processor.", label(`"Automatic" and its description (${auto?.name} / ${auto?.description})`));
  check(wasm?.name === "Processor only" && wasm.description === "Slower, a few seconds a photo, but the cutout is right on every device.", label(`"Processor only" and its description (${wasm?.name} / ${wasm?.description})`));
  check(auto?.checked === "true" && wasm?.checked === "false", label(`"Automatic" is checked to begin with (${auto?.checked} / ${wasm?.checked})`));
  check(p?.redo === false, label("no Redo while the choice matches the photo's engine"));

  const { toasts } = await withToasts(page, async () => {
    await page.click('dialog[open] [role="radio"][data-engine-option="wasm"]');
    await sleep(500);
  });
  p = await enginePicker(page);
  check(p?.radios.find((r) => r.option === "wasm")?.checked === "true" && p?.radios.find((r) => r.option === "auto")?.checked === "false", label("choosing \"Processor only\" flips aria-checked"));
  let stored = await page.evaluate(() => localStorage.getItem("rmbg:engine"));
  check(stored === "wasm", label(`localStorage rmbg:engine is "wasm" (${stored})`));
  check(toasts.length === 0, label(`no toast (${JSON.stringify(toasts)})`));
  const live = await liveTexts(page);
  check(live.includes("Engine: processor only."), label(`the live region says "Engine: processor only." (${JSON.stringify(live)})`));
  check(await page.evaluate(() => !!document.querySelector("dialog[open]")), label("the sheet stays open"));
  check(p?.redo === false, label("no Redo: the photo ran on the processor already"));

  await page.click('dialog[open] [role="radio"][data-engine-option="auto"]');
  await sleep(400);
  p = await enginePicker(page);
  stored = await page.evaluate(() => localStorage.getItem("rmbg:engine"));
  check(p?.radios.find((r) => r.option === "auto")?.checked === "true" && stored === "auto", label(`back to "Automatic" (checked ${p?.radios.find((r) => r.option === "auto")?.checked}, stored ${stored})`));
  check(p?.redo === false, label("no Redo either: automatic is the processor here (no shader-f16)"));
  await page.click('dialog[open] [role="radio"][data-engine-option="wasm"]');
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/phone-more-engine.png` });
  await page.click('dialog[open] button:has-text("Done")');
  await sleep(300);

  // The same context at desktop width, on a fresh load: the stored choice is read at startup.
  await page.setViewportSize(VIEWPORTS[2]);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.setInputFiles("#pick", { name: "disc2.png", mimeType: "image/png", buffer: png });
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("next photo reaches done state"));
    await ctx.close();
    return;
  }
  await sleep(300);
  p = await enginePicker(page);
  check(p?.label === "engine" && p.radios.length === 2 && p.radios.map((r) => r.name).join("|") === "Automatic|Processor only", label(`the desktop control has the two segments under "engine" (${p?.label}: ${p?.radios.map((r) => r.name).join("|")})`));
  check(p?.radios.find((r) => r.option === "wasm")?.checked === "true", label("the desktop control mirrors the stored choice after the reload"));
  check(p?.hint === "Slower, but the cutout is right on every device.", label(`the hint explains "Processor only" (${p?.hint})`));
  const next = await engineCaption(page);
  check(next?.label === "Processor" && next.engine === "wasm", label(`the next photo ran on the processor (${next?.label})`));
  check(p?.redo === false, label("no Redo on the desktop either"));

  const back = await withToasts(page, async () => {
    await page.click('[role="radio"][data-engine-option="auto"]:visible');
    await sleep(500);
  });
  p = await enginePicker(page);
  stored = await page.evaluate(() => localStorage.getItem("rmbg:engine"));
  check(p?.radios.find((r) => r.option === "auto")?.checked === "true" && stored === "auto", label(`"Automatic" on the desktop control flips it and the storage (stored ${stored})`));
  check(p?.hint === "Graphics chip when your device can do it, otherwise the processor.", label(`the hint follows (${p?.hint})`));
  check(back.toasts.length === 0, label(`no toast on the desktop either (${JSON.stringify(back.toasts)})`));
  await page.screenshot({ path: `${SHOTS}/desktop-engine-column.png` });
  await ctx.close();
}

/**
 * `?engine=wasm` forces WebAssembly for the visit without persisting it. Then, on the same
 * warm context, the app's own self-check picture (the 256 px ball) goes through the model so
 * the numbers the check would see on the WebAssembly path are printed and judged with the
 * same function the app uses: the thresholds must accept a right mask from the real model.
 */
async function enginePass(browser, maskCheck) {
  const label = (s) => `engine query: ${s}`;
  const ctx = await newContext(browser, { ...VIEWPORTS[2], theme: "light" });
  const page = await ctx.newPage();
  watch(page, "engine-query");
  await page.goto(`${BASE}/?engine=wasm`, { waitUntil: "networkidle" });
  const png = await makeTestPng(page);
  await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("photo reaches done state"));
    await ctx.close();
    return;
  }
  const b = await engineCaption(page);
  check(b?.label === "Processor" && b.engine === "wasm", label(`caption reads Processor (${b?.label})`));
  const p = await enginePicker(page);
  check(p?.radios.find((r) => r.option === "wasm")?.checked === "true", label("the picker shows \"Processor only\" for the visit"));
  const stored = await page.evaluate(() => localStorage.getItem("rmbg:engine"));
  check(stored === null, label(`nothing persisted to localStorage (${stored})`));

  // The self-check picture on the WebAssembly path.
  const selfLabel = (s) => `self-check picture on wasm: ${s}`;
  await page.goto(`${BASE}/?engine=wasm`, { waitUntil: "networkidle" });
  const ball = await makeTestPng(page, 256);
  await page.setInputFiles("#pick", { name: "ball256.png", mimeType: "image/png", buffer: ball });
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(selfLabel("reaches done state"));
    await ctx.close();
    return;
  }
  await sleep(300);
  const { width, height, data } = await resultRgba(page);
  const rgba = Uint8ClampedArray.from(data);
  const stats = maskCheck.maskStats(rgba, width, height);
  console.log(`info self-check picture on wasm ${width}x${height}: ${fmtStats(stats)} (limits centre >= ${maskCheck.MASK_LIMITS.centreMin}, corners <= ${maskCheck.MASK_LIMITS.cornersMax}, ring <= ${maskCheck.MASK_LIMITS.ringMax})`);
  check(width === 256 && height === 256, selfLabel("keeps its size"));
  check(maskCheck.maskLooksSane(rgba, width, height), selfLabel(`maskLooksSane accepts the real mask (${fmtStats(stats)})`));
  await ctx.close();
}

/**
 * The self-check itself, which headless Chromium cannot reach on its own (its software
 * adapter has no shader-f16, so detection never picks WebGPU). The page's adapter is made to
 * claim the feature; ONNX Runtime's worker still sees the real one and, as before the check
 * existed, returns an all-transparent mask. The check must catch it: the notice names the
 * wrong result, the photo is redone on WebAssembly and the cutout is right.
 */
async function gpuSelfCheckPass(browser, png) {
  const label = (s) => `webgpu self-check: ${s}`;
  const ctx = await newContext(browser, { ...VIEWPORTS[2], theme: "light" });
  await ctx.addInitScript(() => {
    const gpu = navigator.gpu;
    if (!gpu) return;
    const real = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      const adapter = await real(...args);
      if (!adapter) return adapter;
      const features = { has: (name) => name === "shader-f16" || adapter.features.has(name), [Symbol.iterator]: () => adapter.features[Symbol.iterator]() };
      return new Proxy(adapter, {
        get(target, key) {
          if (key === "features") return features;
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
  });
  const page = await ctx.newPage();
  watch(page, "webgpu-spoof", { quiet: true });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const spoofed = await page.evaluate(async () => (await navigator.gpu?.requestAdapter())?.features.has("shader-f16") ?? null);
  check(spoofed === true, label(`page adapter claims shader-f16 (${spoofed})`));

  await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
  const t0 = Date.now();
  // The card first (the original on the stage): it is added before any decode or model work,
  // so a page that shows none never saw the file, a different failure from a run that never finished.
  const added = await page.waitForSelector("img[alt='disc.png']", { timeout: 10_000 }).then(() => true, () => false);
  check(added, label("the card is added"));
  const { result: done, toasts } = await withToasts(page, async () => {
    try {
      await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  });
  check(done, label(`photo reaches done state in ${Math.round((Date.now() - t0) / 1000)}s`));
  if (!done) {
    // What the page was doing when time ran out, for the log: the queue, the status line, the frame, the crash guard's mark.
    const state = await page
      .evaluate(() => ({
        card: !!document.querySelector("img[alt='disc.png']"),
        status: Array.from(document.querySelectorAll('[role="status"], [aria-live]')).map((e) => e.textContent?.trim().slice(0, 120)).filter(Boolean),
        frames: document.querySelectorAll('iframe[src="/gpu-frame"]').length,
        inflight: sessionStorage.getItem("rmbg:inflight"),
        lowMemory: sessionStorage.getItem("rmbg:low-memory"),
        title: document.title,
      }))
      .catch((e) => String(e).split("\n")[0]);
    console.log(`info webgpu self-check timed out: toasts ${JSON.stringify(toasts)} state ${JSON.stringify(state)}`);
    await page.screenshot({ path: `${SHOTS}/webgpu-selfcheck-failed.png` }).catch(() => {});
    await ctx.close().catch(() => {});
    return;
  }
  console.log(`info webgpu self-check toasts ${JSON.stringify(toasts)}`);
  check(toasts.includes("Your graphics chip gave a wrong cutout, so the model now runs on your processor. Slower, but right."), label("fallback notice names the wrong result"));
  const b = await engineCaption(page);
  check(b?.label === "Processor", label(`caption reads Processor after the fallback (${b?.label})`));
  // The page ran WebGPU in its frame and closed it on the way to WebAssembly; the frame held the weights.
  const frames = await page.evaluate(() => document.querySelectorAll('iframe[src="/gpu-frame"]').length);
  check(frames === 0, label(`the WebGPU frame is gone after the fallback (${frames} left)`));
  await sleep(300);
  const { width, height, data } = await resultRgba(page);
  const alpha = (x, y) => data[(y * width + x) * 4 + 3];
  const corners = [alpha(2, 2), alpha(width - 3, 2), alpha(2, height - 3), alpha(width - 3, height - 3)];
  const centre = alpha(Math.round(width / 2), Math.round(height / 2));
  const ring = ringStats(alpha, width, height);
  console.log(`info webgpu self-check result ${width}x${height} corners=${JSON.stringify(corners)} centre alpha ${centre} ring max ${ring.max} mean ${ring.mean.toFixed(2)}`);
  check(corners.every((a) => a === 0), label("corners are transparent (alpha 0)"));
  check(ring.mean < 1 && ring.max <= 64, label(`border is clear (alpha mean ${ring.mean.toFixed(2)}, max ${ring.max})`));
  check(centre >= 250, label(`centre is opaque (alpha ${centre})`));
  await page.screenshot({ path: `${SHOTS}/webgpu-selfcheck-fallback.png` });

  // A second photo in the same session goes straight to WebAssembly, with no second notice. Adding
  // does not move the selection, so its row in the queue list is clicked to bring it on stage.
  const second = await withToasts(page, async () => {
    await page.setInputFiles("#pick", { name: "disc2.png", mimeType: "image/png", buffer: png });
    try {
      await page.click('ul[aria-label="Queue"] button:has-text("disc2.png")', { timeout: 10_000 });
      await page.waitForSelector("img[alt='disc2.png, background removed']", { timeout: MODEL_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  });
  check(second.result, label("a second photo reaches done state on the processor"));
  check(!second.toasts.some((t) => /graphics chip/i.test(t)), label(`no second notice (${JSON.stringify(second.toasts)})`));
  await ctx.close();
}

/**
 * The page runs WebGPU in a hidden frame of its own route, so that route alone may be framed
 * by the site itself, and nothing else may be framed at all.
 */
async function framePass() {
  const label = (s) => `gpu frame: ${s}`;
  const frame = await call(`${BASE}/gpu-frame`);
  const csp = frame.headers.get("content-security-policy") ?? "";
  check(frame.status === 200, label(`/gpu-frame answers 200 (${frame.status})${why(frame)}`));
  check(frame.headers.get("x-frame-options") === "SAMEORIGIN", label(`/gpu-frame is framable by the site (X-Frame-Options ${frame.headers.get("x-frame-options")})`));
  check(/frame-ancestors 'self'/.test(csp), label("/gpu-frame CSP has frame-ancestors 'self'"));
  const home = await call(`${BASE}/`);
  const homeCsp = home.headers.get("content-security-policy") ?? "";
  check(home.headers.get("x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(homeCsp), label(`the page itself stays unframable (X-Frame-Options ${home.headers.get("x-frame-options")})`));
}

/**
 * On a touch screen the two rows of the picker in More must be hittable over all of their
 * height, which is at least 44px. Measured the way a finger lands: `elementFromPoint` down
 * the middle of each row, then a real tap 2px inside the top edge of one and the bottom edge
 * of the other, each of which must select that row.
 */
async function engineTapPass(browser, png) {
  const label = (s) => `engine tap target: ${s}`;
  const ctx = await newContext(browser, { width: 390, height: 844, theme: "light", touch: true });
  const page = await ctx.newPage();
  watch(page, "engine-tap");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  check(coarse, label(`context emulates a touch screen (pointer: coarse ${coarse})`));
  await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("photo reaches done state"));
    await ctx.close();
    return;
  }
  await page.click('nav[aria-label="Photo actions"] button:has-text("More")');
  await page.waitForSelector("dialog[open]");
  await sleep(400);
  const measure = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('dialog[open] [role="radio"][data-engine-option]')).map((b) => {
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2;
        // Pixel centres down the box; layout snaps the box to whole pixels, so one row of rounding is allowed.
        let hit = 0;
        for (let y = Math.floor(r.top) + 0.5; y < r.bottom; y++) if (b.contains(document.elementFromPoint(x, y))) hit++;
        return { option: b.getAttribute("data-engine-option"), height: Math.round(r.height), hit, x, top: r.top, bottom: r.bottom, checked: b.getAttribute("aria-checked") };
      }),
    );
  const rows = await measure();
  check(rows.length === 2, label(`two rows in the sheet (${rows.length})`));
  for (const m of rows) check(m.height >= 44 && m.hit >= m.height - 1, label(`${m.option}: the row is ${m.height}px tall and hittable over ${m.hit}px of it`));
  for (const [option, edge] of [
    ["wasm", "top"],
    ["auto", "bottom"],
    ["wasm", "bottom"],
    ["auto", "top"],
  ]) {
    const m = (await measure()).find((r) => r.option === option);
    if (!m) continue;
    check(m.checked === "false", label(`${option}: not selected before the ${edge} tap`));
    await page.touchscreen.tap(m.x, edge === "top" ? m.top + 2 : m.bottom - 2);
    await sleep(400);
    const after = (await measure()).find((r) => r.option === option);
    check(after?.checked === "true", label(`${option}: a tap 2px inside the ${edge} edge selects it`));
  }
  await page.screenshot({ path: `${SHOTS}/phone-touch-more.png` });
  await page.click('dialog[open] button:has-text("Done")');
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/phone-touch-status.png` });
  await ctx.close();
}

/**
 * Chromium's HTTP cache is per context, so every fresh context would fetch the weights again.
 * One context per theme, resized through the three widths, keeps that to two more downloads.
 */
async function shootResult(browser, png) {
  for (const theme of THEMES) {
    const ctx = await newContext(browser, { ...VIEWPORTS[2], theme });
    const page = await ctx.newPage();
    const label = `result-${theme}`;
    watch(page, label);
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.setInputFiles("#pick", { name: "disc.png", mimeType: "image/png", buffer: png });
    try {
      await page.waitForSelector("img[alt$=', background removed']", { timeout: MODEL_TIMEOUT });
    } catch {
      fail(`${label}: did not reach done state`);
      await page.screenshot({ path: `${SHOTS}/${label}-failed.png` });
      await ctx.close();
      continue;
    }
    await sleep(700);
    for (const vp of VIEWPORTS) {
      const name = `${vp.name}-${theme}-result`;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await sleep(400);
      await page.screenshot({ path: `${SHOTS}/${name}.png` });
      const facts = await layoutFacts(page);
      check(!facts.overflowX, `${name}: no horizontal overflow (${facts.scrollWidth}/${facts.clientWidth})`);
      if (vp.name === "phone") {
        check(facts.barVisible && facts.barBottom !== null && facts.barBottom <= facts.innerHeight, `${name}: fixed bottom bar visible (bottom ${facts.barBottom}/${facts.innerHeight})`);
      } else {
        check(!facts.barVisible, `${name}: phone bar hidden`);
      }
    }
    // Compare view on desktop, for the slider.
    await page.setViewportSize(VIEWPORTS[2]);
    await page.keyboard.press("3");
    await sleep(400);
    const slider = await page.$('[role="slider"]');
    check(!!slider, `${label}: compare slider present`);
    if (slider) {
      const before = await slider.getAttribute("aria-valuenow");
      await slider.focus();
      await page.keyboard.press("ArrowRight");
      await sleep(100);
      const after = await slider.getAttribute("aria-valuenow");
      check(Number(after) > Number(before), `${label}: slider moves with arrow keys (${before} -> ${after})`);
      await page.screenshot({ path: `${SHOTS}/desktop-${theme}-compare.png` });
    }
    await ctx.close();
  }
}

/* ------------------------------------------------------------------ docs */

async function shootDocs(browser) {
  for (const theme of THEMES) {
    for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
      const label = `docs-${vp.width}-${theme}`;
      const ctx = await newContext(browser, { ...vp, theme });
      const page = await ctx.newPage();
      watch(page, label);
      const res = await page.goto(`${BASE}/docs`, { waitUntil: "networkidle" });
      check(res?.status() === 200, `${label}: /docs answers 200 (${res?.status()})`);
      await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: true });
      const facts = await layoutFacts(page);
      check(!facts.overflowX, `${label}: no horizontal overflow (${facts.scrollWidth}/${facts.clientWidth})`);
      check(facts.dark === (theme === "dark"), `${label}: theme applied`);
      const sections = await page.evaluate(() => ["quick", "request", "response", "examples", "limits", "privacy", "self-host", "info"].filter((id) => !document.getElementById(id)));
      check(sections.length === 0, `${label}: all sections present${sections.length ? ` (missing ${sections.join(", ")})` : ""}`);
      // Every code block scrolls on its own; none may push the page wider.
      const wideBlocks = await page.evaluate(() => Array.from(document.querySelectorAll("pre")).filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth).length);
      check(wideBlocks === 0, `${label}: code blocks stay inside the viewport (${wideBlocks} wide)`);
      await ctx.close();
    }
  }
}

/* ------------------------------------------------------------------- api */

const API = `${BASE}/api/v1/remove`;

/** fetch() that never throws: a missing route or a dead server becomes a status of 0 and a FAIL line. */
async function call(url, init) {
  try {
    const res = await fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, ok: res.ok };
  } catch (e) {
    return { status: 0, headers: new Headers(), buf: Buffer.alloc(0), ok: false, error: String(e) };
  }
}

const post = (query, body, headers) => call(`${API}${query}`, { method: "POST", body, headers });
const type = (r) => (r.headers.get("content-type") ?? "").split(";")[0].trim();
const why = (r) => (r.error ? ` (${r.error})` : r.status === 404 ? " (route missing)" : "");

/** RGBA of a few pixels of a decoded image, via sharp (the same decoder the server uses). */
async function pixels(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const at = (x, y) => Array.from(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
  return { width: w, height: h, corners: [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)], centre: at(Math.round(w / 2), Math.round(h / 2)), ring: ringStats((x, y) => data[(y * w + x) * 4 + 3], w, h) };
}

/** A 16x16 red square: enough for the limiter to count, cheap for the model. */
const tinyPng = () => sharp({ create: { width: 16, height: 16, channels: 3, background: "#c2410c" } }).png().toBuffer();

async function apiPass(png) {
  const label = (s) => `api: ${s}`;

  // Raw body, default options.
  {
    const r = await post("", png, { "Content-Type": "image/png" });
    check(r.status === 200, label(`raw PNG -> 200 (${r.status})${why(r)}`));
    check(type(r) === "image/png", label(`raw PNG -> image/png (${type(r) || "none"})`));
    check(!!r.headers.get("x-engine"), label(`X-Engine present (${r.headers.get("x-engine")})`));
    check(/^\d+$/.test(r.headers.get("x-duration-ms") ?? ""), label(`X-Duration-Ms is a number (${r.headers.get("x-duration-ms")})`));
    check(r.headers.get("x-image-size") === "800x600", label(`X-Image-Size is 800x600 (${r.headers.get("x-image-size")})`));
    check(r.headers.get("cache-control") === "no-store", label(`Cache-Control: no-store (${r.headers.get("cache-control")})`));
    check(r.headers.get("access-control-allow-origin") === "*", label(`CORS * on the image (${r.headers.get("access-control-allow-origin")})`));
    if (r.status === 200 && type(r) === "image/png") {
      const px = await pixels(r.buf);
      console.log(`info api result ${px.width}x${px.height} corners=${JSON.stringify(px.corners.map((c) => c[3]))} centre=${JSON.stringify(px.centre)} ring max ${px.ring.max} mean ${px.ring.mean.toFixed(2)}`);
      check(px.width === 800 && px.height === 600, label("result keeps the input size"));
      check(px.corners.every((c) => c[3] === 0), label("corners are transparent (alpha 0)"));
      check(px.ring.mean < 1 && px.ring.max <= 64, label(`border is clear (alpha mean ${px.ring.mean.toFixed(2)}, max ${px.ring.max})`));
      check(px.centre[3] >= 250, label(`centre is opaque (alpha ${px.centre[3]})`));
    } else {
      fail(label("result pixels checked (no image came back)"));
    }
  }

  // Multipart, like curl -F image=@disc.png.
  {
    const form = new FormData();
    form.append("image", new Blob([png], { type: "image/png" }), "disc.png");
    const r = await post("", form);
    check(r.status === 200 && type(r) === "image/png", label(`multipart image=@ -> 200 image/png (${r.status} ${type(r) || "none"})${why(r)}`));
  }

  // Flat backdrop.
  {
    const r = await post("?bg=white", png, { "Content-Type": "image/png" });
    check(r.status === 200, label(`?bg=white -> 200 (${r.status})${why(r)}`));
    if (r.status === 200) {
      const px = await pixels(r.buf);
      const white = (c) => c[3] === 255 && c[0] >= 250 && c[1] >= 250 && c[2] >= 250;
      check(px.corners.every(white), label(`?bg=white corners are opaque white (${JSON.stringify(px.corners[0])})`));
      check(px.ring.max === 255 && px.ring.mean === 255, label(`?bg=white border is fully opaque (alpha mean ${px.ring.mean})`));
    } else {
      fail(label("?bg=white corners are opaque white (no image came back)"));
    }
  }

  // Blur + webp.
  {
    const r = await post("?bg=blur&format=webp", png, { "Content-Type": "image/png" });
    check(r.status === 200 && type(r) === "image/webp", label(`?bg=blur&format=webp -> 200 image/webp (${r.status} ${type(r) || "none"})${why(r)}`));
  }

  // Download header with a name.
  {
    const r = await post("?download&name=disc", png, { "Content-Type": "image/png" });
    const cd = r.headers.get("content-disposition") ?? "";
    check(r.status === 200 && /attachment/.test(cd) && cd.includes("disc-rmbg.png"), label(`?download&name=disc -> Content-Disposition with disc-rmbg.png (${r.status} ${cd || "none"})${why(r)}`));
  }

  // A name outside ASCII (a phone photo in a CJK locale): the header must still be sent, with the real name in filename*.
  {
    const r = await post(`?download&name=${encodeURIComponent("写真.jpg")}`, png, { "Content-Type": "image/png" });
    const cd = r.headers.get("content-disposition") ?? "";
    const star = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? "");
    check(r.status === 200 && star === "写真-rmbg.png" && /filename="[\x20-\x7e]+"/.test(cd), label(`?download&name=写真.jpg -> 200 with filename* decoding back and an ASCII fallback (${r.status} ${cd || "none"})${why(r)}`));
  }

  // Too many pixels: a small file that decodes to 42 MP is refused before the queue, as 413.
  {
    const bomb = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: "#c2410c" } }).png().toBuffer();
    const r = await post("", bomb, { "Content-Type": "image/png" });
    let code = null;
    try {
      code = JSON.parse(r.buf.toString()).error?.code;
    } catch {}
    check(r.status === 413 && code === "too_large", label(`42 MP PNG (${Math.round(bomb.length / 1024)} KB) -> 413 too_large (${r.status} ${code})${why(r)}`));
  }

  // Too large: 13 MB, refused before it is read.
  {
    const r = await post("", Buffer.alloc(13 * 1024 * 1024), { "Content-Type": "image/png" });
    check(r.status === 413, label(`13 MB body -> 413 (${r.status})${why(r)}`));
    let code = null;
    try {
      code = JSON.parse(r.buf.toString()).error?.code;
    } catch {}
    check(code === "too_large", label(`413 body is { error: { code: "too_large" } } (${code})`));
  }

  // Not an image, whatever the header says.
  {
    const r = await post("", Buffer.from("hello, not a png"), { "Content-Type": "image/png" });
    check(r.status === 415, label(`text body with image/png header -> 415 (${r.status})${why(r)}`));
    check(type(r) === "application/json", label(`415 is JSON for a browser-ish client (${type(r) || "none"})`));
    let code = null;
    try {
      code = JSON.parse(r.buf.toString()).error?.code;
    } catch {}
    check(code === "unsupported_type", label(`415 code is unsupported_type (${code})`));
  }

  // The same error for a terminal client: one text line.
  {
    const r = await post("", Buffer.from("hello, not a png"), { "Content-Type": "image/png", "User-Agent": "curl/8.6.0" });
    const body = r.buf.toString();
    check(r.status === 415 && type(r) === "text/plain", label(`curl UA on error -> text/plain (${r.status} ${type(r) || "none"})${why(r)}`));
    check(/^error: .+ \(unsupported_type\)\n?$/.test(body), label(`curl UA error body is "error: message (code)" (${JSON.stringify(body.slice(0, 80))})`));
  }

  // Unknown option values.
  {
    const r = await post("?bg=plaid", png, { "Content-Type": "image/png" });
    check(r.status === 400, label(`?bg=plaid -> 400 (${r.status})${why(r)}`));
  }

  // Capabilities.
  {
    const r = await call(`${BASE}/api/v1/info`);
    let info = null;
    try {
      info = JSON.parse(r.buf.toString());
    } catch {}
    check(r.status === 200 && type(r) === "application/json", label(`GET /api/v1/info -> 200 JSON (${r.status} ${type(r) || "none"})${why(r)}`));
    check(typeof info?.limits?.maxBytes === "number" && typeof info?.limits?.maxEdge === "number", label(`info has numeric limits (${JSON.stringify(info?.limits)})`));
    check(info?.engine === "onnxruntime-node" && Array.isArray(info?.backdrops) && Array.isArray(info?.formats), label(`info names the engine, backdrops and formats (${info?.engine})`));
    check(/max-age=/.test(r.headers.get("cache-control") ?? ""), label(`info is cacheable (${r.headers.get("cache-control")})`));
  }

  // Preflight.
  {
    const r = await call(API, { method: "OPTIONS", headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" } });
    check(r.status === 204, label(`OPTIONS -> 204 (${r.status})${why(r)}`));
    check(r.headers.get("access-control-allow-origin") === "*", label(`OPTIONS carries CORS * (${r.headers.get("access-control-allow-origin")})`));
    check(/POST/.test(r.headers.get("access-control-allow-methods") ?? ""), label(`OPTIONS allows POST (${r.headers.get("access-control-allow-methods")})`));
  }
}

/**
 * Eleven requests at once against a server with the default limit: ten go through and one is
 * 429. At once, so a slow host cannot spread ten model runs past the limiter's minute; the
 * limiter answers before the queue, and 2 running plus 8 waiting is exactly the ten.
 */
async function rateLimitPass() {
  const label = (s) => `api limit: ${s}`;
  const env = { ...process.env };
  delete env.RATE_LIMIT_PER_MIN;
  delete env.DISABLE_RATE_LIMIT;
  try {
    limitServer = await startServer(LIMIT_PORT, env);
  } catch (e) {
    fail(label(`second server on :${LIMIT_PORT} (${e.message})`));
    return;
  }
  const tiny = await tinyPng();
  const rs = await Promise.all(Array.from({ length: 11 }, () => call(`${LIMIT_BASE}/api/v1/remove`, { method: "POST", body: tiny, headers: { "Content-Type": "image/png" } })));
  const statuses = rs.map((r) => r.status);
  console.log(`info limit statuses ${statuses.join(" ")}`);
  const ok = rs.filter((r) => r.status === 200).length;
  const limited = rs.filter((r) => r.status === 429);
  check(ok === 10, label(`ten of eleven requests go through (${ok})${why(rs.find((r) => r.status !== 200 && r.status !== 429) ?? { status: 200 })}`));
  check(limited.length === 1, label(`one is 429 (${limited.length})`));
  const last = limited[0] ?? rs[10];
  check(/^\d+$/.test(last.headers.get("retry-after") ?? ""), label(`429 carries Retry-After in seconds (${last.headers.get("retry-after")})`));
  let code = null;
  try {
    code = JSON.parse(last.buf.toString()).error?.code;
  } catch {}
  check(code === "rate_limited", label(`429 code is rate_limited (${code})`));
}

/**
 * Runs one pass; an exception (a page that went away, a browser that crashed) counts as one
 * failed check with the pass's name and lets the next pass run, so a flaky pass still leaves
 * a full report instead of an aborted one.
 */
async function step(name, run) {
  try {
    return await run();
  } catch (e) {
    fail(`${name}: threw ${String(e).split("\n")[0]}`);
    return undefined;
  }
}

async function main() {
  const maskCheck = await loadMaskCheck();
  maskCheckUnit(maskCheck);
  canRedoUnit(await loadCanRedo());
  mirror = await startMirror();
  await ensureServer();
  const browser = await launch();
  let png = null;
  try {
    await step("empty states", () => shootEmpty(browser));
    await step("docs", () => shootDocs(browser));
    png = (await step("model run", () => runModel(browser))) ?? null;
    await step("engine", () => enginePass(browser, maskCheck));
    if (png) await step("engine picker", () => enginePickerPass(browser, png));
    if (png) await step("engine tap", () => engineTapPass(browser, png));
    if (png) await step("colour picker", () => colourPickerPass(browser, png));
    if (png) await step("crash guard", () => memoryGuardPass(browser, png));
    if (png && process.env.E2E_WEBGPU) await step("webgpu self-check", () => gpuSelfCheckPass(browser, png));
    if (png && browser.isConnected()) await step("result states", () => shootResult(browser, png));
    else if (!png) {
      // The API checks need the test image even when the in-browser model did not finish.
      const page = await browser.newPage();
      png = await makeTestPng(page);
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  if (mirror) console.log(`info model mirror from ${CDN_CACHE}: ${mirror.stats.hits} chunks served from disk, ${mirror.stats.misses} fetched and kept`);
  await framePass();
  await apiPass(png);
  await rateLimitPass();
  const relevant = problems.filter((p) => !/favicon/.test(p));
  if (relevant.length) {
    console.log("info browser problems:\n  " + relevant.join("\n  "));
  }
  check(!relevant.some((p) => /pageerror|Content Security Policy/.test(p)), "no page errors or CSP violations");
  console.log(failures ? `\nFAIL ${failures} check(s) failed` : "\nPASS all checks");
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    if (server) server.kill();
    if (limitServer) limitServer.kill();
    mirror?.server.close();
    process.exit(failures ? 1 : 0);
  });
