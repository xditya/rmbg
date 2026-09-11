import type { NextConfig } from "next";

/**
 * The ONNX Runtime worker (the thread that runs the model on the WebGPU path) is served by
 * Turbopack from /_next/static/media as a module worker and takes its Content Security Policy
 * from its own response, not from the page. The proxy skips _next/static, so it is set here:
 * it may import the wasm glue from a blob URL the page minted, fetch the wasm from another,
 * and spawn thread workers; nothing else. The CDN is not on the list: the library downloads
 * the weights and the runtime on the main thread and hands the worker buffers and blob URLs.
 */
const WORKER_CSP = ["default-src 'none'", "script-src 'self' blob: 'wasm-unsafe-eval'", "connect-src 'self' blob:", "worker-src 'self' blob:"].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/_next/static/media/:path*.mjs",
        headers: [
          { key: "Content-Security-Policy", value: WORKER_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
