import { NextResponse, type NextRequest } from "next/server";
import { GPU_FRAME_PATH } from "@/lib/config";

/**
 * Security headers and a nonce-based Content Security Policy for every page response.
 * The model runs in the browser: ONNX Runtime needs WebAssembly ('wasm-unsafe-eval'), on
 * WebGPU it spawns a same-origin module worker (served from /_next/static/media; that file's
 * own policy is set in next.config.ts since this proxy skips static assets) plus blob: thread
 * workers, it loads its own .wasm binary through fetch() from a blob: URL it minted itself
 * (so connect-src needs blob:), the library's ndarray dependency needs 'unsafe-eval', and the
 * weights are fetched from imgly's CDN. Those are the only holes in the policy. No other
 * origin is ever contacted. Nothing may frame the site except the site itself framing its
 * own WebGPU route (`GPU_FRAME_PATH`), which the page opens hidden to run the model in.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
};

const MODEL_CDN = "https://staticimgly.com";

export function proxy(request: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const framed = request.nextUrl.pathname === GPU_FRAME_PATH;

  const csp = [
    "default-src 'self'",
    // 'unsafe-eval' because @imgly/background-removal depends on ndarray, which builds its typed
    // view constructors with `new Function(...)` at runtime; without it every removal throws an
    // EvalError. Scripts still have to carry the nonce to run at all ('strict-dynamic').
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' 'unsafe-eval'${isDev ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // blob: because onnxruntime-web fetches its wasm binary from an in-page blob URL.
    `connect-src 'self' blob: ${MODEL_CDN}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${framed ? "'self'" : "'none'"}`,
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
  response.headers.set("X-Frame-Options", framed ? "SAMEORIGIN" : "DENY");
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

/**
 * The API is left out: its routes set their own no-store, nosniff and referrer headers, a page
 * CSP means nothing on an image or JSON response, and Next tees every body it proxies through
 * a size-capped clone, which would buffer an upload twice and cut it at that cap.
 */
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|icons/|robots.txt|manifest.webmanifest|opengraph-image|twitter-image).*)"],
};
