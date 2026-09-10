"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { cn } from "@/lib/cn";

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/**
 * The compare handle. It writes `--x` on the frame element directly in requestAnimationFrame
 * while dragging (no React render per move) and reports the value on release; keyboard steps
 * go through `onChange` so the frame re-renders with the new position. Clicking anywhere on
 * the frame jumps the handle there.
 */
export function Compare({
  frameRef,
  value,
  onChange,
  onDragging,
}: {
  frameRef: RefObject<HTMLDivElement | null>;
  value: number;
  onChange: (v: number) => void;
  onDragging?: (dragging: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const raf = useRef(0);
  const pending = useRef(value);

  // Keyboard and remounts: put the frame where React says it is.
  useEffect(() => {
    pending.current = value;
    frameRef.current?.style.setProperty("--x", `${value}%`);
  }, [value, frameRef]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const write = (clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    pending.current = clamp(((clientX - r.left) / r.width) * 100);
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      frame.style.setProperty("--x", `${pending.current}%`);
    });
  };

  const start = (dragging: boolean) => {
    setDragging(dragging);
    onDragging?.(dragging);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start(true);
    write(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    write(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    start(false);
    onChange(Math.round(pending.current));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 100;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(clamp(next));
  };

  return (
    <div
      className="absolute inset-0 cursor-ew-resize touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label="Compare original and result"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value}% original`}
        aria-orientation="horizontal"
        data-dragging={dragging || undefined}
        onKeyDown={onKeyDown}
        className="group/handle absolute inset-y-0 w-11 -translate-x-1/2 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--ring)]"
        style={{ left: "var(--x, 50%)" }}
      >
        <div aria-hidden className="mx-auto h-full w-0.5 bg-white outline outline-1 outline-black/25" />
        <div
          aria-hidden
          className={cn(
            "absolute left-1/2 top-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-fg text-bg outline outline-1 outline-black/25 transition-transform duration-150 ease-quint max-sm:size-9",
            dragging && "scale-95",
          )}
        >
          <ChevronsLeftRight className="size-4" />
        </div>
      </div>
    </div>
  );
}
