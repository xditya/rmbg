"use client";

/**
 * A small WebP thumbnail for queue rows and strips, so a big drop never decodes forty
 * originals at full size. Returns an object URL; the caller revokes it.
 */
export async function makeThumb(file: Blob, edge = 320): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const blob = await paint(bitmap, w, h);
    return URL.createObjectURL(blob);
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
