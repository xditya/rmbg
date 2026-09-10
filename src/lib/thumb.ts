"use client";

export type Thumb = {
  /** Object URL of a small WebP, or undefined when the thumbnail could not be encoded. The caller revokes it. */
  url?: string;
  /** Pixel size of the original, read from the same decode. */
  width: number;
  height: number;
};

/**
 * One decode per photo: reads the pixel size and paints a small WebP for queue rows and
 * strips, so a big drop never decodes forty originals at full size twice. Rejects only when
 * the browser cannot decode the file at all (HEIC on Chrome, corrupt data).
 */
export async function makeThumb(file: Blob, edge = 320): Promise<Thumb> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, edge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
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
