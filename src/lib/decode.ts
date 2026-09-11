/**
 * Decoding without holding a full-size bitmap. A 12 MP phone photo is 48 MB decoded, and a
 * page that decodes it for the thumbnail, again for the dimensions and again to fit it to
 * the model is what makes a phone run out of memory on the first run. So the pixel size
 * comes from an <img> (the browser reads the header; no pixels are decoded until painted)
 * and every bitmap is decoded straight to the size it is needed at. Browser only.
 */

/** Shown when the browser cannot decode a file (HEIC on iOS Safari, exotic AVIF, corrupt data). */
export const UNSUPPORTED_FORMAT_MESSAGE = "This format isn't supported by your browser. Try a JPEG or PNG.";

const unsupported = () => new Error(UNSUPPORTED_FORMAT_MESSAGE);

/**
 * Pixel size as the browser shows the image, EXIF orientation applied (an <img> honours it,
 * so a sideways phone photo reports its upright size). Rejects with the friendly message
 * when the browser cannot decode the format. Decodes no pixels.
 */
export async function loadImageMeta(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof Image === "undefined") throw unsupported();
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(unsupported());
      img.src = url;
    });
    const { naturalWidth: width, naturalHeight: height } = img;
    img.src = "";
    if (!width || !height) throw unsupported();
    return { width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes at full size, honouring EXIF orientation. Rejects with the friendly message. */
export async function decodeFull(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw unsupported();
  }
}

/**
 * Decodes straight to `width` x `height` (the upright size wanted), so the full-size bitmap
 * never exists: Chrome, Safari 15 and Firefox resize inside the decoder. Orientation and
 * resize are meant to compose in that order; a browser that resizes first hands back the
 * two sides swapped, which one retry with the swapped target corrects. A browser that
 * rejects the options gets the full decode, and the caller scales as before.
 */
export async function decodeScaled(file: Blob, width: number, height: number, quality: ResizeQuality): Promise<ImageBitmap> {
  const at = (w: number, h: number) => createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: w, resizeHeight: h, resizeQuality: quality });
  let bitmap: ImageBitmap;
  try {
    bitmap = await at(width, height);
  } catch {
    return decodeFull(file);
  }
  if (width !== height && bitmap.width === height && bitmap.height === width) {
    bitmap.close();
    try {
      bitmap = await at(height, width);
    } catch {
      return decodeFull(file);
    }
  }
  return bitmap;
}
