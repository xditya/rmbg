/**
 * End-to-end smoke test: boots the production server, screenshots the empty and result states
 * at phone / tablet / desktop widths in both themes, runs one real image through the model
 * (WebAssembly in headless Chromium) to check the cutout has a transparent border and an
 * opaque subject, screenshots the docs page, and exercises the HTTP API (POST /api/v1/remove,
 * GET /api/v1/info) against the same server. The 429 check needs the default rate limit, so
 * it spawns one extra short-lived server on PORT + 1 with the limiter at its default.
 *
 *   pnpm build && pnpm e2e
 *
 * Environment: PORT (default 3111), SHOTS (screenshot directory), E2E_TIMEOUT_MS (model wait,
 * default 4 minutes), HTTPS_PROXY (forwarded to Chromium so the model CDN is reachable behind
 * an egress proxy). Never runs `playwright install`: it uses whatever Chromium Playwright
 * resolves from PLAYWRIGHT_BROWSERS_PATH.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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

/** A fresh context with the theme decided before the first paint (the ThemeScript reads localStorage). */
async function newContext(browser, { width, height, theme }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
  }, theme);
  return ctx;
}

const problems = [];
function watch(page, label) {
  page.on("pageerror", (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy|CSP/i.test(m.text())) problems.push(`${label} console.${m.type()}: ${m.text()}`);
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
 */
async function makeTestPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 800;
    c.height = 600;
    const ctx = c.getContext("2d");
    const wall = ctx.createLinearGradient(0, 0, 0, 600);
    wall.addColorStop(0, "#343a42");
    wall.addColorStop(1, "#22262c");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, 800, 600);
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
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

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
      engine: Array.from(document.querySelectorAll("span")).map((s) => s.textContent).find((t) => t === "WebAssembly" || t === "WebGPU") ?? null,
    };
  });
  console.log(`info result ${pixels.width}x${pixels.height} engine=${pixels.engine} corners=${JSON.stringify(pixels.corners.map((c) => c[3]))} centre=${JSON.stringify(pixels.centre)} ring max ${pixels.ring.max} mean ${pixels.ring.mean.toFixed(2)}`);
  check(pixels.width === 800 && pixels.height === 600, "result keeps the input size");
  check(pixels.corners.every((c) => c[3] === 0), "corners are transparent (alpha 0)");
  check(pixels.ring.mean < 1 && pixels.ring.max <= 64, `border is clear (alpha mean ${pixels.ring.mean.toFixed(2)}, max ${pixels.ring.max})`);
  check(pixels.centre[3] >= 250, `centre is opaque (alpha ${pixels.centre[3]})`);
  check(pixels.engine === "WebAssembly" || pixels.engine === "WebGPU", `engine label shown (${pixels.engine})`);

  await ctx.close();
  return png;
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
  await ensureServer();
  const browser = await launch();
  let png = null;
  try {
    await shootEmpty(browser);
    await shootDocs(browser);
    png = await runModel(browser);
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
