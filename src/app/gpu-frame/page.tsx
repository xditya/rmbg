import type { Metadata } from "next";
import { GpuFrame } from "@/components/gpu-frame";

/**
 * The document the page frames to run WebGPU in; see `src/lib/remove.ts`. Opened on its own
 * it only says so. Kept out of search results: it is not a page anyone should land on.
 */
export const metadata: Metadata = {
  title: "WebGPU engine",
  robots: { index: false, follow: false },
};

export default function GpuFramePage() {
  return <GpuFrame />;
}
