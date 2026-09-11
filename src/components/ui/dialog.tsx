"use client";

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type TouchEvent } from "react";
import { X } from "lucide-react";
import { IconButton } from "./button";
import { cn } from "@/lib/cn";

/** Drag distance (px) past which a swipe on the sheet header dismisses it. */
const SWIPE_CLOSE = 80;
/** How long the closing fade runs before the element is actually closed. */
const DIALOG_EXIT_MS = 150;

/**
 * Modal built on the native <dialog> element. Centred on desktop; on phones it becomes a
 * bottom sheet (full width, rounded top, clear of the home indicator) so it reads as an app
 * surface rather than a shrunken desktop window. On phones the header (grabber + title)
 * can be dragged down to dismiss.
 */
export function Dialog({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const drag = useRef<{ y: number; dy: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // A swipe-dismiss leaves the sheet translated off screen; the element is reused, so reset it.
      el.style.transform = "";
      el.style.transition = "";
      delete el.dataset.closing;
      el.showModal();
      el.querySelector<HTMLElement>("[autofocus], [data-autofocus]")?.focus();
    }
    if (!open && el.open) {
      // The exit plays before the native close (see `dialog[data-closing]` in globals.css); an
      // inline transition left by a touch on the header would beat it and skip the fade.
      el.style.transition = "";
      el.dataset.closing = "";
      const t = setTimeout(() => {
        if (el.open) el.close();
        delete el.dataset.closing;
      }, DIALOG_EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Sheets are often unmounted while open; closing first lets the browser return focus to
  // whatever opened them (layout cleanups run before React detaches the node).
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.open) el.close();
    };
  }, []);

  const onTouchStart = (e: TouchEvent) => {
    if (window.innerWidth >= 640) return;
    drag.current = { y: e.touches[0].clientY, dy: 0 };
    if (ref.current) ref.current.style.transition = "none";
  };
  const onTouchMove = (e: TouchEvent) => {
    const el = ref.current;
    if (!drag.current || !el) return;
    drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y);
    el.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onTouchEnd = () => {
    const el = ref.current;
    const d = drag.current;
    drag.current = null;
    if (!el || !d) return;
    if (d.dy > SWIPE_CLOSE) {
      // Already off screen when it closes, so the native close (and its `close` event) is the
      // exit here; the inline styles are reset on the next open.
      el.style.transition = "transform 160ms var(--ease)";
      el.style.transform = "translateY(100%)";
      setTimeout(() => el.close(), 150);
      return;
    }
    el.style.transition = "transform 200ms var(--ease)";
    el.style.transform = "";
    // Only for the snap-back: a close after it must get the stylesheet's fade.
    setTimeout(() => {
      if (el.style.transition === "transform 200ms var(--ease)") el.style.transition = "";
    }, 200);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[min(92vw,28rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
        "max-sm:mx-0 max-sm:mb-0 max-sm:mt-auto max-sm:max-h-[88dvh] max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:rounded-t-xl max-sm:border-x-0 max-sm:border-b-0 max-sm:px-inset",
      )}
    >
      <div className="touch-none" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-border-strong sm:hidden" />
        <div className="flex items-center justify-between border-b border-border px-4 py-3 max-sm:pt-2">
          <h2 id={titleId} className="min-w-0 truncate text-[14px] font-semibold">
            {title}
          </h2>
          <IconButton label="Close" size="sm" onClick={onClose} className="[@media(pointer:coarse)]:size-11">
            <X className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className={cn(className ?? "px-4 py-4", "max-sm:pb-safe")}>{children}</div>
    </dialog>
  );
}
