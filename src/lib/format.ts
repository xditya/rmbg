/** Small formatters for the status lines. All output is plain text; no locale surprises. */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "25 MB": whole megabytes, for limits quoted in copy. */
export function formatWholeMB(n: number): string {
  return `${Math.round(n / (1024 * 1024))} MB`;
}

/** "2,400 × 1,600" */
export function formatDims(w: number, h: number): string {
  return `${w.toLocaleString("en-US")} × ${h.toLocaleString("en-US")}`;
}

/** "4,096 px" */
export function formatPx(n: number): string {
  return `${n.toLocaleString("en-US")} px`;
}

/** "1.8 s" under ten seconds, "12 s" after that. */
export function formatMs(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/**
 * "photo.jpg" → "photo-rmbg.png". The stem is used as a download and share file name, so path
 * separators, control characters (DEL and the Unicode bidi controls too, which would show the
 * "-rmbg.png" tail reversed) and other characters file systems refuse become dashes, and very
 * long names are cut.
 */
export function resultName(name: string): string {
  const stem =
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, "-")
      .replace(/^[.\s-]+|[.\s-]+$/g, "")
      .slice(0, 120) || "photo";
  return `${stem}-rmbg.png`;
}

/** "12.4 of 41.2 MB" */
export function formatMB(loaded: number, total: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `${mb(loaded)} of ${mb(total)} MB`;
}
