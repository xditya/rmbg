/** Small formatters for the status lines. All output is plain text; no locale surprises. */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "2,400 × 1,600" */
export function formatDims(w: number, h: number): string {
  return `${w.toLocaleString("en-US")} × ${h.toLocaleString("en-US")}`;
}

/** "1.8 s" under ten seconds, "12 s" after that. */
export function formatMs(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** "photo.jpg" → "photo-rmbg.png" */
export function resultName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").trim() || "photo";
  return `${stem}-rmbg.png`;
}

/** "12.4 of 41.2 MB" */
export function formatMB(loaded: number, total: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `${mb(loaded)} of ${mb(total)} MB`;
}
