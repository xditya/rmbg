"use client";

/** Saving, copying and sharing a PNG. Every function assumes a browser and a user gesture. */

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function canCopyImages(): boolean {
  return typeof window !== "undefined" && "ClipboardItem" in window && typeof navigator.clipboard?.write === "function";
}

/**
 * Writes a PNG to the clipboard. Takes a promise so the call can happen synchronously inside
 * the click: Safari only allows clipboard writes within the gesture, and composing a large
 * image can take longer than that window.
 */
export function copyPng(blob: Promise<Blob>): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

let shareProbe: boolean | undefined;

/** Whether the Web Share API accepts files here. Probed once with a tiny PNG. */
export function canShareFiles(): boolean {
  if (shareProbe !== undefined) return shareProbe;
  try {
    const probe = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "probe.png", { type: "image/png" });
    shareProbe = typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
  } catch {
    shareProbe = false;
  }
  return shareProbe;
}

export function sharePng(file: File): Promise<void> {
  return navigator.share({ files: [file], title: file.name });
}
