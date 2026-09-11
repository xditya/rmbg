"use client";

import { useEffect } from "react";
import { registerModelCache } from "@/lib/model-cache";

/** Mounted once in the layout: registers the service worker that keeps the model on the device (see public/sw.js). */
export function ModelCache() {
  useEffect(() => {
    void registerModelCache();
  }, []);
  return null;
}
