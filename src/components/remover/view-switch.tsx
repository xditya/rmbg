"use client";

import type { KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

export type View = "original" | "result" | "compare";

const OPTIONS: { key: View; label: string }[] = [
  { key: "original", label: "Original" },
  { key: "result", label: "Result" },
  { key: "compare", label: "Compare" },
];

const SHIFT: Record<View, string> = { original: "translate-x-0", result: "translate-x-full", compare: "translate-x-[200%]" };

/**
 * Original · Result · Compare as a radiogroup with a sliding indicator. Result and Compare
 * are disabled (but still read) until the card is done.
 */
export function ViewSwitch({
  value,
  onChange,
  disabled,
  className,
}: {
  value: View;
  onChange: (v: View) => void;
  disabled: { result: boolean; compare: boolean };
  className?: string;
}) {
  const enabled = (v: View) => v === "original" || !disabled[v];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const keys = OPTIONS.map((o) => o.key).filter(enabled);
    const i = keys.indexOf(value);
    const next = keys[(i + dir + keys.length) % keys.length];
    if (next && next !== value) {
      onChange(next);
      e.currentTarget.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="View"
      onKeyDown={onKeyDown}
      className={cn("relative grid h-8 grid-cols-3 rounded-md border border-border bg-surface p-0.5 max-sm:h-11", className)}
    >
      <div
        aria-hidden
        className={cn("absolute inset-y-0.5 left-0.5 w-[calc(33.333%-2px)] rounded-[5px] bg-surface-2 transition-transform duration-200 ease-quint", SHIFT[value])}
      />
      {OPTIONS.map((o) => {
        const on = o.key === value;
        const off = !enabled(o.key);
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            data-view={o.key}
            aria-checked={on}
            aria-disabled={off || undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => {
              if (!off) onChange(o.key);
            }}
            className={cn(
              "relative z-[1] h-full rounded-[5px] text-[13px] font-medium transition-colors duration-200 ease-quint",
              on ? "text-fg" : "text-fg-muted",
              off ? "cursor-default opacity-40" : "hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
