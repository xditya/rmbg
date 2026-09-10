# rmbg

Drop a photo, keep the subject.

rmbg removes the background from a photo, right in your browser. Nothing is uploaded. The model runs on your device, the photo never leaves it, and there is nothing to sign up for.

## what it does

- Drop, pick or paste a photo. Several at once is fine; they are done one after another.
- The subject is cut out on your device and shown over a checkerboard, with a before/after slider.
- Pick a backdrop: transparent, white, black, any colour, or the original blurred.
- Download the PNG (`<name>-rmbg.png`), copy it, or share it where the browser allows.
- Works on phones, tablets and desktops. Keyboard shortcuts on desktop: `d` download, `c` copy, `n` new photo, `1` `2` `3` switch views, `[` `]` move through the queue, `Backspace` remove.

PNG, JPEG, WebP, GIF, BMP and AVIF work, up to 25 MB each. Photos over 4,096 px on the long side are scaled down before the cut, so the result is at most that size.

## nothing is uploaded

There is no server side to this. The page is static, there are no API routes, no analytics, no accounts and no cookies. The only network request the app makes on its own is the one that fetches the model weights, once.

## the model

The cut is done by [`@imgly/background-removal`](https://github.com/imgly/background-removal-js), which runs the ISNet model with ONNX Runtime Web. WebGPU is used when the browser has it; otherwise it falls back to WebAssembly, once and quietly.

- The weights (about 40 MB) are fetched from imgly's CDN (`staticimgly.com`) on the first run and cached by the browser after that.
- The library is AGPL-3.0 licensed, with a commercial licence available from IMG.LY. This project uses it as-is and does not bundle the weights.
- The result is a PNG with alpha at the size the model saw, which is the original size unless the photo was scaled down first.

## run it

Node 22 and pnpm.

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm check      # lint, typecheck, build
pnpm build && pnpm e2e   # production server + headless Chromium smoke test
```

The end-to-end script boots the built app on port 3111, screenshots the empty and result states at phone, tablet and desktop widths in both themes, runs one generated image through the model on the WebAssembly path, and checks the cutout's corners are transparent and its centre is opaque.

## deploy

It is a plain Next.js app. On Vercel: import the repo, build with the defaults, done. No environment variables are needed; `NEXT_PUBLIC_SITE_URL` can be set to pin the origin used for canonical and Open Graph URLs (see `.env.example`).

The Content Security Policy in `src/proxy.ts` is deliberately tight. It opens exactly what the model needs: `'wasm-unsafe-eval'` and `'unsafe-eval'` for ONNX Runtime and the library's ndarray dependency, `blob:` workers and connections, and `connect-src` to the weights CDN.

## credits

The look borrows from [pastr](https://github.com/xditya/pastr) and [engram](https://github.com/xditya/engram): the same tokens, the same restraint, the same promise that it runs on your device. Icons by [Lucide](https://lucide.dev). Model and runtime by [IMG.LY](https://img.ly) and [ONNX Runtime](https://onnxruntime.ai).
