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

/**
 * The API runs the model with onnxruntime-node and sharp: native modules, left out of the
 * bundle and loaded from node_modules at runtime. The tracer follows the `require` to the
 * linux/x64 binding (it resolves the platform on the build machine, so the darwin and win32
 * excludes below are belt and braces) but cannot see the shared library the binding dlopens
 * next to itself, so that one file is added by hand: without it every cold start on Vercel
 * fails inside `import "onnxruntime-node"`. Only the one file, not the directory: it also
 * holds a byte-identical versioned copy and, if the package's postinstall ever runs, the
 * CUDA providers.
 */
const ORT_LIB = "bin/napi-v3/linux/x64/libonnxruntime.so.1";
// Only the real directory under .pnpm. The flat node_modules/onnxruntime-node path is a symlink,
// and a traced file that passes through a symlinked directory makes Vercel reject the whole
// function ("invalid deployment package"). With npm the flat path is the real one; the tracer
// then finds the binding there and this include is a no-op, so self-hosters are unaffected.
const ORT_LINUX_LIB = [`./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/${ORT_LIB}`];
const ORT_FOREIGN_BINARIES = ["darwin", "win32"].map((os) => `./node_modules/.pnpm/onnxruntime-node*/node_modules/onnxruntime-node/bin/napi-v3/${os}/**`);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["onnxruntime-node", "sharp"],
  outputFileTracingIncludes: { "/api/v1/remove": ORT_LINUX_LIB },
  outputFileTracingExcludes: { "/api/v1/remove": ORT_FOREIGN_BINARIES },
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
