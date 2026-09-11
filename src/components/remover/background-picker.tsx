"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import type { BackdropChoice } from "@/lib/backdrop";

type Kind = BackdropChoice["kind"];

/** `auto`: desktop size, tall on phones and on any touch screen (a 768px iPad is still a finger). */
const SIZES = { md: "size-8", lg: "size-11", auto: "size-8 max-sm:size-11 [@media(pointer:coarse)]:size-11" } as const;

const LABELS: Record<Kind, string> = { transparent: "Transparent", white: "White", black: "Black", custom: "Custom colour", blur: "Blurred original" };
const ORDER: Kind[] = ["transparent", "white", "black", "custom", "blur"];

/** The placeholder shown on the custom swatch until a colour is picked: the one non-token colour in the UI. */
const RAINBOW = "conic-gradient(from 0deg, #e5484d, #f5a524, #30a46c, #0091ff, #8e4ec6, #e5484d)";

/**
 * Transparent · white · black · custom · blur as a radiogroup of round swatches. The custom
 * swatch is the native colour input laid over a radio: pointer taps open the picker directly,
 * keyboard activation opens it through `showPicker`, and live `input` events are throttled
 * to one update per frame (iOS fires them continuously).
 */
export function BackgroundPicker({
  value,
  onChange,
  previewUrl,
  disabled,
  size,
  className,
}: {
  value: BackdropChoice;
  onChange: (b: BackdropChoice) => void;
  /** Small image for the blur swatch (the thumb, or the original). */
  previewUrl?: string;
  disabled?: boolean;
  size: keyof typeof SIZES;
  className?: string;
}) {
  const [customHex, setCustomHex] = useState<string | null>(value.kind === "custom" ? value.hex : null);
  const colorRef = useRef<HTMLInputElement>(null);
  const raf = useRef(0);
  const pending = useRef<string | null>(null);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const pick = (kind: Kind) => {
    if (disabled) return;
    if (kind === "custom") {
      if (customHex) onChange({ kind: "custom", hex: customHex });
      return;
    }
    onChange({ kind } as BackdropChoice);
  };

  const onColorInput = (hex: string) => {
    pending.current = hex;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (pending.current) {
        setCustomHex(pending.current);
        onChange({ kind: "custom", hex: pending.current });
      }
    });
  };

  const openPicker = () => {
    const input = colorRef.current;
    if (!input || disabled) return;
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        /* fall through to click */
      }
    }
    input.click();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir || disabled) return;
    e.preventDefault();
    // From the focused swatch, not the checked one: focus can rest on Custom before a colour is picked.
    const cur = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]")?.dataset.kind as Kind | undefined;
    const i = ORDER.indexOf(cur ?? value.kind);
    const next = ORDER[(i + dir + ORDER.length) % ORDER.length];
    if (next === "custom" && !customHex) {
      e.currentTarget.querySelector<HTMLElement>('[data-kind="custom"]')?.focus();
      return;
    }
    pick(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus();
  };

  const swatch = (kind: Kind, on: boolean) =>
    cn(
      "relative shrink-0 rounded-full border transition-[opacity,transform] duration-200 ease-quint active:scale-[.97]",
      // The flat white and black swatches need a boundary that reads against the surface in either theme.
      kind === "white" || kind === "black" ? "border-fg/50" : "border-border-strong",
      SIZES[size],
      on && "ring-2 ring-fg ring-offset-2 ring-offset-surface",
      disabled && "cursor-not-allowed opacity-40",
      kind === "transparent" && "bg-checker",
      kind === "white" && "bg-white",
      kind === "black" && "bg-black",
      kind === "blur" && "overflow-hidden",
    );

  return (
    <div role="radiogroup" aria-label="Background" onKeyDown={onKeyDown} className={cn("flex items-center", className)}>
      {ORDER.map((kind) => {
        const on = value.kind === kind;
        const tab = on ? 0 : -1;
        if (kind === "custom") {
          return (
            <span key={kind} className="relative inline-flex">
              <button
                type="button"
                role="radio"
                data-kind={kind}
                aria-checked={on}
                aria-label={LABELS[kind]}
                aria-disabled={disabled || undefined}
                tabIndex={tab}
                onClick={openPicker}
                className={swatch(kind, on)}
                style={{ background: customHex ?? RAINBOW }}
              />
              <input
                ref={colorRef}
                type="color"
                defaultValue="#888888"
                aria-hidden
                tabIndex={-1}
                disabled={disabled}
                onInput={(e) => onColorInput(e.currentTarget.value)}
                className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              />
            </span>
          );
        }
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            data-kind={kind}
            aria-checked={on}
            aria-label={LABELS[kind]}
            aria-disabled={disabled || undefined}
            tabIndex={tab}
            onClick={() => pick(kind)}
            className={swatch(kind, on)}
          >
            {kind === "blur" && previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset
              <img src={previewUrl} alt="" aria-hidden className="size-full scale-125 rounded-full object-cover blur-[3px]" draggable={false} />
            )}
          </button>
        );
      })}
    </div>
  );
}
