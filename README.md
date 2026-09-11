# rmbg

Drop a photo, keep the subject.

rmbg removes the background from a photo, right in your browser. Nothing is uploaded. The model runs on your device, the photo never leaves it, and there is nothing to sign up for.

## what it does

- Drop, pick or paste a photo. Several at once is fine; they are done one after another.
- The subject is cut out on your device and shown over a checkerboard, with a before/after slider.
- Pick a backdrop: transparent, white, black, any colour, or the original blurred.
- Download the PNG (`<name>-rmbg.png`), copy it, or share it where the browser allows.
- Works on phones, tablets and desktops. Keyboard shortcuts on desktop, while the tool has focus: `d` download, `c` copy, `n` new photo, `1` `2` `3` switch views, `[` `]` move through the queue, `⌘`/`Ctrl` + `Backspace` remove.

PNG, JPEG, WebP, GIF, BMP and AVIF work, up to 25 MB each (the limits live in `src/lib/config.ts`). Photos over 4,096 px on the long side are scaled down before the cut, so the result is at most that size. A format the browser cannot decode, HEIC on most of them, fails on its card with a note to try a JPEG or PNG.

## nothing is uploaded

There is no server side to this beyond serving the page: no API routes, no analytics, no accounts and no cookies. The only requests the app makes on its own are the ones that fetch the model and its runtime from imgly's CDN, once; after that they come from the browser cache.

## the model

The cut is done by [`@imgly/background-removal`](https://github.com/imgly/background-removal-js), which runs the ISNet model with ONNX Runtime Web. WebGPU is used when the browser has it; if it fails, the same photo is retried on WebAssembly and a small notice says so. A plain network failure is not a WebGPU failure: the card says the model didn't download and offers to try again on the same engine.

- The model and runtime are fetched from imgly's CDN (`staticimgly.com`) on the first run and cached by the browser after that: about 105 MB on WebGPU (`isnet_fp16` plus the WebGPU build of the runtime), about 55 MB on WebAssembly (`isnet_quint8` plus the plain build). The hero and the status line quote the figure for the engine in use.
- On WebGPU the model runs in a worker. On WebAssembly the library runs it on the main thread, so the page pauses for the length of the inference (a few seconds, longer on a phone); the status line says so while it happens.
- The result is a PNG with a transparent background, at the size the model saw: the original size unless the photo was scaled down first.

## run it

Node 22 and pnpm.

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm check      # lint, typecheck, build
pnpm build && pnpm e2e   # production server + headless Chromium smoke test
```

The end-to-end script boots the built app on port 3111, screenshots the empty and result states at phone, tablet and desktop widths in both themes, runs one generated image through the model on the WebAssembly path, and checks the cutout's corners are transparent and its centre is opaque. It needs Playwright's Chromium: run `pnpm exec playwright install chromium` once, or point `PLAYWRIGHT_BROWSERS_PATH` at an existing install. Screenshots land in `e2e/screens/` (override with `SHOTS`).

## deploy

It is a plain Next.js app. On Vercel: import the repo, build with the defaults, done. No environment variables are needed; `NEXT_PUBLIC_SITE_URL` can be set to pin the origin used for canonical and Open Graph URLs (see `.env.example`).

The Content Security Policy in `src/proxy.ts` is deliberately tight. It opens exactly what the model needs: `'wasm-unsafe-eval'` and `'unsafe-eval'` for ONNX Runtime and the library's ndarray dependency, same-origin and `blob:` workers and connections, and `connect-src` to the weights CDN. The runtime's own worker script is a static asset the proxy does not see, so `next.config.ts` gives it a policy of its own.

## credits

The look borrows from [pastr](https://github.com/xditya/pastr) and [engram](https://github.com/xditya/engram): the same tokens, the same restraint, the same promise that it runs on your device. Icons by [Lucide](https://lucide.dev). Model and runtime by [IMG.LY](https://img.ly) and [ONNX Runtime](https://onnxruntime.ai).

## the library's licence

The background-removal library is AGPL-3.0. Its code ships in the page's JavaScript, so if you host rmbg you are bound by those terms unless you buy IMG.LY's commercial licence; the weights are fetched from their CDN, not bundled.
