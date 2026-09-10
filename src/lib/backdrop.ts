import type { Backdrop } from "@/lib/remove";

/** What the picker offers. The engine's `Backdrop` is derived per photo (blur radius depends on size). */
export type BackdropChoice = { kind: "transparent" } | { kind: "white" } | { kind: "black" } | { kind: "custom"; hex: string } | { kind: "blur" };

export const TRANSPARENT: BackdropChoice = { kind: "transparent" };

/** Blur radius in result pixels: a fortieth of the long edge, clamped so tiny and huge photos both look right. */
export function blurRadius(width: number, height: number): number {
  return Math.min(64, Math.max(8, Math.round(Math.max(width, height) / 40)));
}

/** The flat colour a choice paints, or null for transparent and blur. */
export function backdropColor(choice: BackdropChoice): string | null {
  switch (choice.kind) {
    case "white":
      return "#ffffff";
    case "black":
      return "#000000";
    case "custom":
      return choice.hex;
    default:
      return null;
  }
}

export function toBackdrop(choice: BackdropChoice, width: number, height: number): Backdrop {
  if (choice.kind === "blur") return { kind: "blur", radius: blurRadius(width, height) };
  const hex = backdropColor(choice);
  return hex ? { kind: "color", hex } : { kind: "transparent" };
}

/** Stable key for caching composed PNGs per choice. */
export function backdropKey(choice: BackdropChoice): string {
  return choice.kind === "custom" ? `custom:${choice.hex}` : choice.kind;
}
