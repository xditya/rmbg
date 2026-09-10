"use client";

import { useEffect, type RefObject } from "react";

export type Hotkey = {
  /** e.g. "mod+s", "mod+enter", "escape", "mod+shift+c" — mod = ⌘ on macOS, Ctrl elsewhere */
  combo: string;
  handler: (e: KeyboardEvent) => void;
  /** allow while typing in inputs (default true for mod combos, false for bare keys) */
  inInputs?: boolean;
};

function matches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const modPressed = isMac() ? e.metaKey : e.ctrlKey;
  if (mods.has("mod") !== modPressed) return false;
  if (mods.has("shift") !== e.shiftKey) return false;
  if (mods.has("alt") !== e.altKey) return false;
  const k = e.key.toLowerCase();
  if (key === "escape") return k === "escape";
  if (key === "enter") return k === "enter";
  if (key === "slash") return k === "/";
  return k === key;
}

export type HotkeyOptions = {
  /**
   * Only fire while focus is inside this element. Bare single-character shortcuts must be
   * scoped to a component to pass WCAG 2.1.4, so the tool root is focusable and clicks inside
   * it keep focus there.
   */
  within?: RefObject<HTMLElement | null>;
};

export function useHotkeys(hotkeys: Hotkey[], options: HotkeyOptions = {}) {
  const { within } = options;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("dialog[open]")) return;
      if (within && !(target && within.current?.contains(target))) return;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      for (const h of hotkeys) {
        if (!h.combo.includes("+") && (e.ctrlKey || e.metaKey || e.altKey)) continue;
        if (!matches(e, h.combo)) continue;
        const allowInInputs = h.inInputs ?? h.combo.includes("mod+");
        if (typing && !allowInInputs) continue;
        e.preventDefault();
        h.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, within]);
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
}
