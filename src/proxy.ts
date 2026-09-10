import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers and a nonce-based Content Security Policy for every page response.
 * The model runs in the browser: ONNX Runtime needs WebAssembly ('wasm-unsafe-eval'), on
 * WebGPU it spawns a same-origin module worker (served from /_next/static/media; that file's
 * own policy is set in next.config.ts since this proxy skips static assets) plus blob: thread
 * workers, it loads its own .wasm binary through fetch() from a blob: URL it minted itself
 * (so connect-src needs blob:), the library's ndarray dependency needs 'unsafe-eval', and the
 * weights are fetched from imgly's CDN. Those are the only holes in the policy. No other
 * origin is ever contacted.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Frame-Options": "DENY",
};

const MODEL_CDN = "https://staticimgly.com";

export function proxy(request: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

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
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|icons/|robots.txt|manifest.webmanifest|opengraph-image|twitter-image).*)"],
};
