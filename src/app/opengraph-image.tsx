import { ImageResponse } from "next/og";
import { SITE } from "@/lib/config";

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* The light palette as hex: OG images cannot read CSS variables. */
const C = { bg: "#f4f5f7", fg: "#15171a", muted: "#5c6370", faint: "#666d75" };

/** The brand mark drawn with boxes: a solid dot over a dashed frame. */
function Mark({ size }: { size: number }) {
  const r = size / 24;
  return (
    <div style={{ display: "flex", position: "relative", width: size, height: size }}>
      <div style={{ position: "absolute", left: 3 * r, top: 3 * r, width: 18 * r, height: 18 * r, border: `${1.75 * r}px dashed ${C.fg}`, borderRadius: 4 * r }} />
      <div style={{ position: "absolute", left: 7.5 * r, top: 7.5 * r, width: 9 * r, height: 9 * r, borderRadius: 9999, background: C.fg }} />
    </div>
  );
}

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: C.bg, color: C.fg, padding: 72, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flex: 1, gap: 28 }}>
          <Mark size={96} />
          <div style={{ display: "flex", fontSize: 64, fontWeight: 600, letterSpacing: -2, lineHeight: 1 }}>{SITE.name}</div>
          <div style={{ display: "flex", fontSize: 32, color: C.muted, letterSpacing: -0.5 }}>{SITE.tagline}</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: C.faint, fontFamily: "monospace" }}>runs on your device · nothing is uploaded</div>
      </div>
    ),
    size,
  );
}
