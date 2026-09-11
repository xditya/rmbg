"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useClientFact } from "@/hooks/use-media";
import { serveGpuFrame } from "@/lib/gpu-frame";

const isFramed = () => window.parent !== window;

/** Serves the parent page's WebGPU requests while framed; explains itself when opened directly. */
export function GpuFrame() {
  // Framed until hydration says otherwise, so the standalone note never flashes inside the page's frame.
  const framed = useClientFact(isFramed, true);
  useEffect(() => (isFramed() ? serveGpuFrame() : undefined), []);
  if (framed) return null;
  return (
    <main className="mx-auto max-w-[520px] px-4 py-12 text-[14px] leading-relaxed text-fg-muted">
      <p>
        This page is the frame rmbg runs WebGPU in; there is nothing to see here.{" "}
        <Link href="/" className="text-fg underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-fg">
          Back to rmbg
        </Link>
      </p>
    </main>
  );
}
