/**
 * Judges the cutout of the self-check picture: a lit ball in the middle of a dark wall (see
 * `drawSelfCheckImage` in remove.ts). A sane mask is opaque in the centre, clear at the edges
 * and not flat. Pure and import-free on purpose: the e2e script runs it under plain node by
 * stripping the type annotations, so keep every annotation a bare `: number`-style token.
 */

export type MaskStats = { centre: number; corners: number; ring: number; allEqual: boolean };

/** Mean alpha (0..255) the centre must reach, and the most the corners and the outer ring may carry. */
export const MASK_LIMITS = { centreMin: 200, cornersMax: 40, ringMax: 24, edge: 8, centreSize: 5 };

/**
 * `centre`: mean alpha of the middle 5x5. `corners`: mean alpha over the four 8x8 corner
 * squares. `ring`: mean alpha over every pixel within 8 px of an edge. `allEqual`: every pixel
 * is the same RGBA as the first (a blank or flat mask).
 */
export function maskStats(rgba: Uint8ClampedArray, width: number, height: number): MaskStats {
  const edge = MASK_LIMITS.edge;
  const alpha = (x: number, y: number) => rgba[(y * width + x) * 4 + 3];
  const mean = (x0: number, y0: number, w: number, h: number) => {
    let sum = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) sum += alpha(x, y);
    return sum / (w * h);
  };

  const half = Math.floor(MASK_LIMITS.centreSize / 2);
  const centre = mean(Math.floor(width / 2) - half, Math.floor(height / 2) - half, MASK_LIMITS.centreSize, MASK_LIMITS.centreSize);

  const corners = (mean(0, 0, edge, edge) + mean(width - edge, 0, edge, edge) + mean(0, height - edge, edge, edge) + mean(width - edge, height - edge, edge, edge)) / 4;

  // Top and bottom bands over the full width, then the left and right bands between them.
  const top = mean(0, 0, width, edge) * width * edge;
  const bottom = mean(0, height - edge, width, edge) * width * edge;
  const sides = (mean(0, edge, edge, height - 2 * edge) + mean(width - edge, edge, edge, height - 2 * edge)) * edge * (height - 2 * edge);
  const ring = (top + bottom + sides) / (2 * width * edge + 2 * edge * (height - 2 * edge));

  let allEqual = true;
  for (let i = 4; i < rgba.length && allEqual; i += 4) {
    if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2] || rgba[i + 3] !== rgba[3]) allEqual = false;
  }

  return { centre, corners, ring, allEqual };
}

/** Whether a mask of the self-check picture is plausible. False for anything too small to measure. */
export function maskLooksSane(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  if (width < 3 * MASK_LIMITS.edge || height < 3 * MASK_LIMITS.edge || rgba.length < width * height * 4) return false;
  const s = maskStats(rgba, width, height);
  return s.centre >= MASK_LIMITS.centreMin && s.corners <= MASK_LIMITS.cornersMax && s.ring <= MASK_LIMITS.ringMax && !s.allEqual;
}
