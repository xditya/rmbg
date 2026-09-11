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

The page has no server side beyond serving it: no analytics, no accounts and no cookies. The only requests it makes on its own are the ones that fetch the model and its runtime from imgly's CDN, once; after that they come from the browser cache. The one exception is the [API](#api) below, which is opt-in: nothing on the page calls it.

## the model

The cut is done by [`@imgly/background-removal`](https://github.com/imgly/background-removal-js), which runs the ISNet model with ONNX Runtime Web. WebGPU is used when the browser has it; if it fails, the same photo is retried on WebAssembly and a small notice says so. A plain network failure is not a WebGPU failure: the card says the model didn't download and offers to try again on the same engine. WebGPU runs in a hidden frame of the page's own `/gpu-frame` route rather than in the page: ONNX Runtime keeps one global initialised flag per document, and once its WebGPU proxy worker has started there a WebAssembly session in the same document can no longer be created, which would leave the fallback stuck. The frame shares the browser cache, so the weights are still fetched once.

- The model and runtime are fetched from imgly's CDN (`staticimgly.com`) on the first run and cached by the browser after that: about 105 MB on WebGPU (`isnet_fp16` plus the WebGPU build of the runtime), about 55 MB on WebAssembly (`isnet_quint8` plus the plain build). The hero and the status line quote the figure for the engine in use.
- On WebGPU the model runs in a worker. On WebAssembly the library runs it on the main thread, so the page pauses for the length of the inference (a few seconds, longer on a phone); the status line says so while it happens.
- The result is a PNG with a transparent background, at the size the model saw: the original size unless the photo was scaled down first.

### if cutouts look wrong

The WebGPU build runs the fp16 model, which needs f16 shader support (`shader-f16`) on the graphics adapter; without it ONNX Runtime still runs and returns a wrong mask rather than an error. So the page only picks WebGPU when the adapter reports the feature, and then checks the first result: before the first photo it runs a small synthetic picture (a lit ball on a dark wall) through the model and looks at the mask (opaque centre, clear edges). A wrong mask sends the session to WebAssembly on its own, with a notice. If a cutout still looks wrong, the engine name under the photo (`WebGPU` / `WebAssembly`) is a button: one press runs the next photo on WebAssembly, the next brings automatic detection back; the choice is kept in `localStorage` (`rmbg:engine`). Opening the page with `?engine=wasm` forces WebAssembly for that visit without keeping it.

## api

The same cut over plain HTTP, for scripts and other apps. No keys, no accounts, nothing stored. Unlike the page, the API runs the model on the server: the photo is uploaded, held in memory for the request, and gone when the response is sent. The full reference lives at `/docs` on a running instance.

```sh
curl --data-binary @photo.jpg -H 'Content-Type: image/jpeg' https://rmbg.example.com/api/v1/remove -o photo-rmbg.png
curl -F image=@photo.jpg 'https://rmbg.example.com/api/v1/remove?bg=blur&format=webp' -o photo-rmbg.webp
```

- `POST /api/v1/remove` takes the photo as the raw body, or as multipart with a field named `image` (or `file`). Options go in the query string (multipart fields work too): `bg` is `transparent` (default), `white`, `black`, a hex colour (`#1e90ff`, with or without the hash) or `blur`; `format` is `png` (default) or `webp`; `download` adds a `Content-Disposition` with `<name>-rmbg.png` (`.webp` for webp), the stem from `?name=` or, without it, the upload's file name.
- The answer is the image, with `X-Engine: onnxruntime-node`, `X-Duration-Ms` and `X-Image-Size: WxH`. Errors are JSON, `{ "error": { "code", "message" } }`, with the codes `invalid`, `unauthorized`, `too_large`, `unsupported_type`, `rate_limited`, `busy`, `engine` and, for anything else, `internal_error`; curl, wget, httpie and xh (or `?plain`) get one line of text instead. CORS is open, so a browser on any origin can call it.
- Limits: 12 MB and 40 megapixels per request (413), the same 4,096 px long edge as the page (bigger photos are scaled down first), JPEG, PNG, WebP, GIF, AVIF and TIFF in (anything else is 415), and 10 requests per minute per IP (429 with `Retry-After`). Each process runs two photos at once and queues a few more; past that it answers 503 with `Retry-After: 5`.
- `GET /api/v1/info` says what an instance takes: limits, backdrops, formats, the rate limit and whether a key is needed.
- Environment, all optional (see `.env.example`): `API_KEY` locks the API behind `Authorization: Bearer <key>`; `RATE_LIMIT_PER_MIN` changes the limit; `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or the Vercel `KV_REST_API_*` names) share the limit across instances with a sliding window, otherwise each process counts in memory; `TRUSTED_PROXY_HOPS` for a reverse proxy; `RMBG_MODEL_URL` to fetch the weights from somewhere other than imgly's CDN, and `RMBG_MODEL_SHA256` to pin what that mirror serves.
- On the server the weights are `isnet_quint8` (44 MB), fetched once from the CDN, checked against the sha256 pinned in `src/lib/config.ts`, and cached under the system temp directory, so a warm instance does not fetch them again. A run takes 2 to 5 s on a typical function; the route asks Vercel for a 60 s cap (`maxDuration`), which every plan allows: 300 s with Fluid Compute (on by default for new projects), 60 s on Hobby without it. On Vercel the platform caps request bodies at 4.5 MB, below the 12 MB the route allows, and answers its own 413 for bigger uploads. The function ships the linux binding plus `libonnxruntime.so.1` (about 45 MB with sharp) via `outputFileTracingIncludes` in `next.config.ts`, well under the 250 MB limit.
- The CPU runtime needs none of the CUDA libraries `onnxruntime-node`'s postinstall would download, so `package.json` tells pnpm not to run it; with npm, set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` at install time.

## run it

Node 22 and pnpm.

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm check      # lint, typecheck, build
pnpm build && pnpm e2e   # production server + headless Chromium smoke test
```

The end-to-end script boots the built app on port 3111, screenshots the empty and result states at phone, tablet and desktop widths in both themes, runs one generated image through the model on the WebAssembly path, and checks the cutout's border is clear and its centre is opaque. It exercises the engine switch (the label button, its 44px touch target, `?engine=wasm`) and the mask judge behind the WebGPU self-check; with `E2E_WEBGPU=1` it also turns on Chromium's software WebGPU adapter, checks that detection still lands on WebAssembly (no `shader-f16`), and makes one page's adapter claim the feature so the self-check has to catch the wrong mask and fall back. It then screenshots `/docs` at phone and desktop widths, sends the same image through the API in every backdrop and format and checks each error code, and boots a second server on port 3112 with the default rate limit to see the eleventh request get a 429. It needs Playwright's Chromium: run `pnpm exec playwright install chromium` once, or point `PLAYWRIGHT_BROWSERS_PATH` at an existing install. Screenshots land in `e2e/screens/` (override with `SHOTS`). Each browser context starts with an empty cache, so the script keeps the model chunks on disk between runs (`E2E_CDN_CACHE`, default `rmbg-e2e-cdn` under the system temp directory, `0` to turn it off); they are content-addressed and checked against their sha256 before being served or kept.

## deploy

It is a plain Next.js app. On Vercel: import the repo, build with the defaults, done. No environment variables are needed; `NEXT_PUBLIC_SITE_URL` can be set to pin the origin used for canonical and Open Graph URLs, and the [API](#api) has a few optional ones of its own (see `.env.example`).

The Content Security Policy in `src/proxy.ts` is deliberately tight. It opens exactly what the model needs: `'wasm-unsafe-eval'` and `'unsafe-eval'` for ONNX Runtime and the library's ndarray dependency, same-origin and `blob:` workers and connections, and `connect-src` to the weights CDN. The runtime's own worker script is a static asset the proxy does not see, so `next.config.ts` gives it a policy of its own.

## credits

The look borrows from [pastr](https://github.com/xditya/pastr) and [engram](https://github.com/xditya/engram): the same tokens, the same restraint, the same promise that it runs on your device. Icons by [Lucide](https://lucide.dev). Model and runtime by [IMG.LY](https://img.ly) and [ONNX Runtime](https://onnxruntime.ai).

## the library's licence

The background-removal library is AGPL-3.0. Its code ships in the page's JavaScript, so if you host rmbg you are bound by those terms unless you buy IMG.LY's commercial licence; the weights are fetched from their CDN, not bundled.
