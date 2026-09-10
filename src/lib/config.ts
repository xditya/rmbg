/** Site-wide constants. Safe to import from server and client code. */
export const SITE = {
  name: "rmbg",
  tagline: "Drop a photo, keep the subject.",
  description: "Remove the background from any image, right in your browser. Nothing is uploaded: the model runs on your device and the photo never leaves it.",
  repo: "https://github.com/xditya/rmbg",
} as const;

export const LIMITS = {
  /** Largest file we will try. Bigger photos are downscaled before inference anyway. */
  maxBytes: 25 * 1024 * 1024,
  /** Longest edge we feed the model; the cutout is scaled back to the original size. */
  maxEdge: 4096,
  /** Most files one drop can add; the rest are skipped with a toast. */
  maxFiles: 30,
  accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"],
} as const;
