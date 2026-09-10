import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers and a nonce-based Content Security Policy for every response.
 * The model runs in the browser: ONNX Runtime needs WebAssembly ('wasm-unsafe-eval') and blob
 * workers, and the weights are fetched from imgly's CDN, so those are the only holes in the
 * policy. No other origin is ever contacted.
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
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${MODEL_CDN}`,
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
