"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Check, Cpu, RotateCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sheetRow } from "@/components/ui/dialog";
import type { Card } from "@/hooks/use-queue";
import { modelCacheNote, type ModelStatus } from "@/lib/config";
import { modelStatuses, subscribeModelLoaded, type Engine, type EnginePreference, type ModelStatuses } from "@/lib/remove";
import { cn } from "@/lib/cn";

/**
 * The two choices, in plain words: WebGPU is "the graphics chip", WebAssembly "the processor".
 * `model` is the engine whose files the option's badge describes: "Automatic" stands for the
 * graphics-chip model even on a device that resolves it to the processor.
 */
const OPTIONS: { key: EnginePreference; model: Engine; label: string; icon: typeof Zap; description: string; hint: string }[] = [
  {
    key: "auto",
    model: "webgpu",
    label: "Automatic",
    icon: Zap,
    description: "Graphics chip when your device can do it, the fast way. Otherwise the processor.",
    hint: "Graphics chip when your device can do it, otherwise the processor.",
  },
  {
    key: "wasm",
    model: "wasm",
    label: "Processor only",
    icon: Cpu,
    description: "Slower, a few seconds a photo, but the cutout is right on every device.",
    hint: "Slower, but the cutout is right on every device.",
  },
];

const UNKNOWN: ModelStatuses = { webgpu: "unknown", wasm: "unknown" };

/**
 * Whether each engine's files are on the device (the service worker's cache), read when the
 * picker becomes active (mount, or the sheet opening) and again the first time a model
 * finishes loading on each engine, so the badge flips to "Downloaded" as it happens. One
 * read covers both options, from the cache alone once anything has been downloaded.
 */
function useModelStatuses(active: boolean): ModelStatuses {
  const [statuses, setStatuses] = useState<ModelStatuses>(UNKNOWN);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const refresh = () => {
      void modelStatuses().then((next) => {
        if (live) setStatuses(next);
      });
    };
    refresh();
    const stop = subscribeModelLoaded(refresh);
    return () => {
      live = false;
      stop();
    };
  }, [active]);
  return statuses;
}

/** The trailing mono fragment of an option's description: "Downloaded", or the size it would download. */
function Badge({ engine, status }: { engine: Engine; status: ModelStatus }) {
  return (
    <span className="font-mono text-[11.5px] text-fg-faint" data-model-status={status}>
      {modelCacheNote(engine, status)}
    </span>
  );
}

const SHIFT: Record<EnginePreference, string> = { auto: "translate-x-0", wasm: "translate-x-full" };

/**
 * Whether "Redo this photo" makes sense: the card is done, and the engine it ran on is not
 * the one the preference now implies. "Processor only" after a graphics-chip cut is the
 * usual case (the cutout looked wrong); "Automatic" after a processor cut only counts when
 * detection says the graphics chip is really available, else the redo would change nothing.
 */
export function canRedo(card: Pick<Card, "state" | "engine"> | null, preference: EnginePreference, detected: Engine | null): boolean {
  if (!card || card.state !== "done" || !card.engine) return false;
  if (preference === "wasm") return card.engine === "webgpu";
  return card.engine === "wasm" && detected === "webgpu";
}

/**
 * The engine choice as a radiogroup of two. `list`: full-width rows in the phone More sheet,
 * a filled disc on the selected one. `segmented`: a two-segment control like the view
 * switch, for the desktop column (stacked) and the tablet toolbar (`inline`: label, control,
 * hint and Redo on one wrapping line), with the choice explained beside or beneath it.
 * `onRedo`, when given, adds "Redo this photo" (see `canRedo`).
 */
export function EnginePicker({
  shape,
  value,
  onChange,
  onRedo,
  inline,
  active = true,
  className,
}: {
  shape: "list" | "segmented";
  value: EnginePreference;
  onChange: (next: EnginePreference) => void;
  onRedo?: (() => void) | null;
  inline?: boolean;
  /** Whether the picker is on screen (a sheet passes its open state); the badges are read while it is. */
  active?: boolean;
  className?: string;
}) {
  const labelId = useId();
  const statuses = useModelStatuses(active);

  // Arrows move the choice, like the view switch; the roving tabindex keeps one tab stop.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const keys = OPTIONS.map((o) => o.key);
    const next = keys[(keys.indexOf(value) + dir + keys.length) % keys.length];
    if (next !== value) {
      onChange(next);
      e.currentTarget.querySelector<HTMLElement>(`[data-engine-option="${next}"]`)?.focus();
    }
  };

  if (shape === "list") {
    return (
      <div className={className}>
        <p id={labelId} className="px-4 pb-1.5 pt-3 font-mono text-[12px] text-fg-faint">
          engine · applies to the next photo
        </p>
        <div role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown} className="divide-y divide-border">
          {OPTIONS.map((o) => {
            const on = o.key === value;
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                data-engine-option={o.key}
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => onChange(o.key)}
                className={cn(sheetRow, "h-auto min-h-14 py-2 text-fg")}
              >
                <o.icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{o.label}</span>
                  <span className="text-[12.5px] leading-snug text-fg-muted">
                    <span data-engine-hint>{o.description}</span> <Badge engine={o.model} status={statuses[o.model]} />
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ease-quint",
                    on ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface text-transparent",
                  )}
                >
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>
        {onRedo && (
          <button type="button" className={cn(sheetRow, "border-t border-border text-fg")} onClick={onRedo}>
            <RotateCcw className="size-4 text-fg-muted" aria-hidden />
            Redo this photo
          </button>
        )}
      </div>
    );
  }

  const current = OPTIONS.find((o) => o.key === value) ?? OPTIONS[0];
  return (
    <div className={cn("flex", inline ? "flex-wrap items-center gap-x-3 gap-y-2" : "flex-col", className)}>
      <p id={labelId} className={cn("text-[12px] text-fg-faint", inline ? "w-full sm:w-auto" : "mb-2")}>
        engine
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        // On touch screens (tablets) the 2px gutter goes so the radios themselves are the full 44px.
        className={cn(
          "relative grid h-8 grid-cols-2 rounded-md border border-border bg-surface p-0.5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:p-0",
          inline && "w-[264px]",
        )}
      >
        <div
          aria-hidden
          className={cn(
            "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[5px] bg-surface-2 transition-transform duration-200 ease-quint",
            "[@media(pointer:coarse)]:inset-y-0 [@media(pointer:coarse)]:left-0 [@media(pointer:coarse)]:w-1/2",
            SHIFT[value],
          )}
        />
        {OPTIONS.map((o) => {
          const on = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              data-engine-option={o.key}
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(o.key)}
              className={cn("relative z-[1] h-full rounded-[5px] text-[13px] font-medium transition-colors duration-200 ease-quint hover:text-fg", on ? "text-fg" : "text-fg-muted")}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className={cn("text-[12.5px] leading-snug text-fg-muted", inline ? "min-w-0" : "mt-1.5")}>
        <span data-engine-hint>{current.hint}</span> <Badge engine={current.model} status={statuses[current.model]} />
      </p>
      {onRedo && (
        <Button size="sm" className={cn("self-start", inline ? "[@media(pointer:coarse)]:h-11" : "mt-2")} onClick={onRedo}>
          <RotateCcw className="size-3.5" aria-hidden />
          Redo this photo
        </Button>
      )}
    </div>
  );
}
