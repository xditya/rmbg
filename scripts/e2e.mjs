/**
 * End-to-end smoke test: boots the production server, screenshots the empty and result states
 * at phone / tablet / desktop widths in both themes, runs one real image through the model
 * (WebAssembly in headless Chromium) to check the cutout has a transparent border and an
 * opaque subject, exercises the engine switch (the label button, its touch target,
 * `?engine=wasm`) and the mask judge behind the WebGPU self-check, checks the headers of the
 * frame the page runs WebGPU in, screenshots the docs page, and exercises the HTTP API
 * (POST /api/v1/remove, GET /api/v1/info) against the same server. The 429 check needs the
 * default rate limit, so it spawns one extra short-lived server on PORT + 1 with the limiter
 * at its default.
 *
 *   pnpm build && pnpm e2e
 *
 * Environment: PORT (default 3111), SHOTS (screenshot directory), E2E_TIMEOUT_MS (model wait,
 * default 4 minutes), HTTPS_PROXY (forwarded to Chromium so the model CDN is reachable behind
 * an egress proxy), E2E_CDN_CACHE (where the weights are kept between runs, see `cacheCdn`;
 * `0` turns the cache off), E2E_WEBGPU=1 (turns on Chromium's software WebGPU adapter:
 * detection must still pick WebAssembly, since it has no shader-f16, and a page whose adapter
 * is made to claim the feature must be caught by the self-check and fall back). Never runs
 * `playwright install`: it uses whatever Chromium Playwright resolves from
 * PLAYWRIGHT_BROWSERS_PATH.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** The library's default publicPath: where the weights and the runtime come from. */
const CDN = "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/";
const CDN_CACHE = process.env.E2E_CDN_CACHE === "0" ? null : resolve(process.env.E2E_CDN_CACHE ?? resolve(tmpdir(), "rmbg-e2e-cdn"));

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

/** Boots `next start` on `port` with the given extra environment and waits for it. */
async function startServer(port, env) {
  console.log(`info starting next start on :${port}`);
  // Run Next's bin directly under this node: killing the child then really stops the server.
  // Going through `pnpm start` leaves an orphaned next-server holding the port after cleanup.
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env });
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
    console.log(`info reusing server on ${BASE} (its rate limit is whatever it was started with)`);
    return;
  }
  // A high limit for the functional checks; the 429 check gets its own server with the default.
  server = await startServer(PORT, { ...process.env, RATE_LIMIT_PER_MIN: "1000" });
}

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
  await cacheCdn(ctx);
  return ctx;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isChunk = (name) => /^[0-9a-f]{64}$/.test(name);
const cdnStats = { hits: 0, misses: 0 };

/**
 * The model CDN, cached on disk between runs. Every context is a fresh profile with an empty
 * HTTP cache, so without this each of the half-dozen contexts that run the model would fetch
 * the weights again (55 MB on WebAssembly, 111 MB more on the spoofed WebGPU pass), which is
 * what made the runs time out on a slow link. The chunks are content-addressed (the file name
 * is the sha256 of the bytes), so a cached chunk is only served when it still checks out and
 * a fetched one is only kept when it does; resources.json is always fetched live. The
 * requests still go through Chromium's own network stack (and proxy) on a miss.
 */
async function cacheCdn(ctx) {
  if (!CDN_CACHE) return;
  mkdirSync(CDN_CACHE, { recursive: true });
  await ctx.route(`${CDN}**`, async (route) => {
    const name = route.request().url().slice(CDN.length).split("?")[0];
    const file = resolve(CDN_CACHE, name);
    try {
      if (isChunk(name) && existsSync(file)) {
        const body = readFileSync(file);
        if (sha256(body) === name) {
          cdnStats.hits++;
          return await route.fulfill({ status: 200, contentType: "application/octet-stream", body });
        }
      }
      // No timeout of our own: a 4 MB chunk can take minutes on a slow link, and the page has its own.
      const response = await route.fetch({ timeout: 0 });
      const body = await response.body();
      if (response.ok() && isChunk(name) && sha256(body) === name) {
        cdnStats.misses++;
        writeFileSync(file, body);
      }
      return await route.fulfill({ response, body });
    } catch (e) {
      // The page went away mid-fetch (a navigation, a closed context), or the fetch failed: hand the
      // request back to the browser, which reports it the way it would without the cache.
      await route.continue().catch(() => {});
      if (!/aborted|closed|Target page/i.test(String(e))) console.log(`info cdn cache: ${name.slice(0, 12)} not cached (${String(e).split("\n")[0]})`);
    }
  });
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

/** The engine button under the photo: its label, the engine it names and the action it offers. */
const engineButton = (page) =>
  page.evaluate(() => {
    const b = document.querySelector("button[data-engine]");
    return b ? { label: b.textContent?.trim() ?? "", engine: b.getAttribute("data-engine"), action: b.getAttribute("title"), aria: b.getAttribute("aria-label") } : null;
  });

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
        const lines = Array.from(document.querySelectorAll("span, p, button[data-engine]")).map((e) => e.textContent?.trim() ?? "");
        return { title: document.title, status: lines.filter((l) => /downloading|removing|failed|WebAssembly|WebGPU|queued|waiting/i.test(l)).slice(0, 4), bar: !!t };
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
      engine: document.querySelector("button[data-engine]")?.textContent?.trim() ?? null,
    };
  });
  console.log(`info result ${pixels.width}x${pixels.height} engine=${pixels.engine} corners=${JSON.stringify(pixels.corners.map((c) => c[3]))} centre=${JSON.stringify(pixels.centre)} ring max ${pixels.ring.max} mean ${pixels.ring.mean.toFixed(2)}`);
  check(pixels.width === 800 && pixels.height === 600, "result keeps the input size");
  check(pixels.corners.every((c) => c[3] === 0), "corners are transparent (alpha 0)");
  check(pixels.ring.mean < 1 && pixels.ring.max <= 64, `border is clear (alpha mean ${pixels.ring.mean.toFixed(2)}, max ${pixels.ring.max})`);
  check(pixels.centre[3] >= 250, `centre is opaque (alpha ${pixels.centre[3]})`);
  // Chromium's software adapter (E2E_WEBGPU) has no shader-f16, so detection must land on WebAssembly there.
  if (process.env.E2E_WEBGPU) check(pixels.engine === "WebAssembly", `engine label reads WebAssembly on the software adapter (${pixels.engine})`);
  else check(pixels.engine === "WebAssembly" || pixels.engine === "WebGPU", `engine label shown (${pixels.engine})`);

  await engineTogglePass(page, png);

  await ctx.close();
  return png;
}

/**
 * The engine label is a button. One press: a toast, the action flips to "Back to automatic",
 * the choice lands in localStorage and the next photo (a fresh load reads it at startup) runs
 * on WebAssembly with its label saying so. A second press brings automatic detection back.
 */
async function engineTogglePass(page, png) {
  const label = (s) => `engine switch: ${s}`;
  const before = await engineButton(page);
  check(before?.action === "Switch to WebAssembly" && before.aria === before.action, label(`button offers "Switch to WebAssembly" (${before?.action} / ${before?.aria})`));

  const { toasts } = await withToasts(page, async () => {
    await page.click("button[data-engine]");
    await sleep(600);
  });
  check(toasts.includes("The next photo runs on WebAssembly."), label(`press toasts "The next photo runs on WebAssembly." (${JSON.stringify(toasts)})`));
  const after = await engineButton(page);
  check(after?.action === "Back to automatic", label(`action flips to "Back to automatic" (${after?.action})`));
  const stored = await page.evaluate(() => localStorage.getItem("rmbg:engine"));
  check(stored === "wasm", label(`localStorage rmbg:engine is "wasm" (${stored})`));

  // The next photo, on a fresh load of the same context: the stored choice is read at startup.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.setInputFiles("#pick", { name: "disc2.png", mimeType: "image/png", buffer: png });
  try {
    await page.waitForSelector(DONE, { timeout: MODEL_TIMEOUT });
  } catch {
    fail(label("next photo reaches done state"));
    return;
  }
  const next = await engineButton(page);
  check(next?.label === "WebAssembly" && next.engine === "wasm", label(`next photo ran on WebAssembly (${next?.label})`));
  check(next?.action === "Back to automatic", label(`the choice survived the reload (${next?.action})`));

  const back = await withToasts(page, async () => {
    await page.click("button[data-engine]");
    await sleep(600);
  });
  check(back.toasts.includes("The next photo picks the engine automatically."), label(`second press toasts "The next photo picks the engine automatically." (${JSON.stringify(back.toasts)})`));
  const reset = await engineButton(page);
  const storedBack = await page.evaluate(() => localStorage.getItem("rmbg:engine"));
  check(reset?.action === "Switch to WebAssembly" && storedBack === "auto", label(`back to automatic (${reset?.action}, stored ${storedBack})`));
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
  const b = await engineButton(page);
  check(b?.label === "WebAssembly" && b.engine === "wasm", label(`label reads WebAssembly (${b?.label})`));
  check(b?.action === "Back to automatic", label(`button offers "Back to automatic" (${b?.action})`));
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
    await page.screenshot({ path: `${SHOTS}/webgpu-selfcheck-failed.png` });
    await ctx.close();
    return;
  }
  console.log(`info webgpu self-check toasts ${JSON.stringify(toasts)}`);
  check(toasts.includes("WebGPU gave a wrong result on this device, so the model runs on WebAssembly instead."), label("fallback notice names the wrong result"));
  const b = await engineButton(page);
  check(b?.label === "WebAssembly", label(`label reads WebAssembly after the fallback (${b?.label})`));
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
  check(second.result, label("a second photo reaches done state on WebAssembly"));
  check(!second.toasts.some((t) => /WebGPU/.test(t)), label(`no second notice (${JSON.stringify(second.toasts)})`));
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
 * On a touch screen the engine button must be hittable over all of its 44px: the status rows
 * grow to that height under `pointer: coarse` so no neighbour paints over it. Measured the way
 * a finger lands: `elementFromPoint` down the middle of the button, then a real tap 2px inside
 * the top and the bottom edge, each of which must flip the preference. The phone row (under
 * the stage) and the tablet row (the stage footer) are different elements, so both widths.
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
  const measure = () =>
    page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button[data-engine]")).find((e) => e.getClientRects().length > 0);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      // Pixel centres down the box; layout snaps the box to whole pixels, so one row of rounding is allowed.
      let hit = 0;
      for (let y = Math.floor(r.top) + 0.5; y < r.bottom; y++) if (b.contains(document.elementFromPoint(x, y))) hit++;
      return { height: Math.round(r.height), hit, x, top: r.top, bottom: r.bottom, preference: b.getAttribute("data-engine-preference") };
    });
  for (const vp of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 820, height: 1180 },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await sleep(300);
    const m = await measure();
    check(m !== null && m.height >= 44 && m.hit >= 43, label(`${vp.name}: button is ${m?.height}px tall and hittable over ${m?.hit}px of it`));
    if (!m) continue;
    for (const [edge, y] of [
      ["top", m.top + 2],
      ["bottom", m.bottom - 2],
    ]) {
      const before = (await measure())?.preference;
      await page.touchscreen.tap(m.x, y);
      await sleep(400);
      const after = (await measure())?.preference;
      check(before !== after, label(`${vp.name}: a tap 2px inside the ${edge} edge flips the preference (${before} -> ${after})`));
    }
  }
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

async function main() {
  const maskCheck = await loadMaskCheck();
  maskCheckUnit(maskCheck);
  await ensureServer();
  const browser = await launch();
  let png = null;
  try {
    await shootEmpty(browser);
    await shootDocs(browser);
    png = await runModel(browser);
    await enginePass(browser, maskCheck);
    if (png) await engineTapPass(browser, png);
    if (png && process.env.E2E_WEBGPU) await gpuSelfCheckPass(browser, png);
    if (png) await shootResult(browser, png);
    else {
      // The API checks need the test image even when the in-browser model did not finish.
      const page = await browser.newPage();
      png = await makeTestPng(page);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (CDN_CACHE) console.log(`info model CDN cache at ${CDN_CACHE}: ${cdnStats.hits} chunks served from disk, ${cdnStats.misses} fetched and kept`);
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
    process.exit(failures ? 1 : 0);
  });
