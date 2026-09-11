"use client";

import { decodeScaled, loadImageMeta } from "@/lib/decode";

export type Thumb = {
  /** Object URL of a small WebP, or undefined when the thumbnail could not be encoded. The caller revokes it. */
  url?: string;
  /** Pixel size of the original, as the browser shows it (EXIF orientation applied). */
  width: number;
  height: number;
};

/**
 * One small decode per photo: the pixel size comes from the image header (an <img>, no
 * pixels), and the bitmap is decoded straight to thumbnail size, so a big drop never holds
 * a full-size bitmap, let alone forty. Rejects only when the browser cannot decode the file
 * at all (HEIC on Chrome, corrupt data).
 */
export async function makeThumb(file: Blob, edge = 320): Promise<Thumb> {
  const { width, height } = await loadImageMeta(file);
  const scale = Math.min(1, edge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bitmap = await decodeScaled(file, w, h, "low");
  try {
    try {
      const blob = await paint(bitmap, w, h);
      return { url: URL.createObjectURL(blob), width, height };
    } catch {
      return { width, height };
    }
  } finally {
    bitmap.close();
  }
}

async function paint(bitmap: ImageBitmap, w: number, h: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/webp", 0.8));
}
