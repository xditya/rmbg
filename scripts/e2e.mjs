/**
 * End-to-end smoke test: boots the production server, screenshots the empty and result states
 * at phone / tablet / desktop widths in both themes, and runs one real image through the model
 * (WebAssembly in headless Chromium) to check the cutout has a transparent border and an
 * opaque subject.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3111);
const BASE = `http://localhost:${PORT}`;
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

async function isUp() {
  try {
    const r = await fetch(`${BASE}/`, { redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

let server = null;
async function ensureServer() {
  if (await isUp()) {
    console.log(`info reusing server on ${BASE}`);
    return;
  }
  console.log(`info starting next start on :${PORT}`);
  // Run Next's bin directly under this node: killing the child then really stops the server.
  // Going through `pnpm start` leaves an orphaned next-server holding the port after cleanup.
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 120; i++) {
    if (await isUp()) return;
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
    await sleep(500);
  }
  throw new Error("server did not come up in 60s");
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

/** A coloured disc on a soft gradient, drawn in-page so no fixture file is needed. */
async function makeTestPng(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 800;
    c.height = 600;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 800, 600);
    g.addColorStop(0, "#f3efe6");
    g.addColorStop(1, "#cfd6e2");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 800, 600);
    // subject: a bold disc with a soft shadow, plus a darker rim so the edge is unambiguous
    ctx.shadowColor = "rgba(0,0,0,.35)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 18;
    ctx.fillStyle = "#c2410c";
    ctx.beginPath();
    ctx.arc(400, 300, 170, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#7c2d12";
    ctx.stroke();
    ctx.fillStyle = "#fed7aa";
    ctx.beginPath();
    ctx.arc(340, 240, 40, 0, Math.PI * 2);
    ctx.fill();
    return c.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
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
    return {
      width: w,
      height: h,
      corners: [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)],
      centre: at(Math.round(w / 2), Math.round(h / 2)),
      engine: Array.from(document.querySelectorAll("span")).map((s) => s.textContent).find((t) => t === "WebAssembly" || t === "WebGPU") ?? null,
    };
  });
  console.log(`info result ${pixels.width}x${pixels.height} engine=${pixels.engine} corners=${JSON.stringify(pixels.corners.map((c) => c[3]))} centre=${JSON.stringify(pixels.centre)}`);
  check(pixels.width === 800 && pixels.height === 600, "result keeps the input size");
  check(pixels.corners.every((c) => c[3] === 0), "corners are transparent (alpha 0)");
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

async function main() {
  await ensureServer();
  const browser = await launch();
  try {
    await shootEmpty(browser);
    const png = await runModel(browser);
    if (png) await shootResult(browser, png);
  } finally {
    await browser.close();
  }
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
    process.exit(failures ? 1 : 0);
  });
