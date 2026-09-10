"use client";

import { Camera, ImagePlus } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Logo } from "@/components/logo";
import { modelDownloadNote, SITE } from "@/lib/config";
import type { Engine } from "@/lib/remove";
import { cn } from "@/lib/cn";

/**
 * The empty state: a hero that is also the dropzone. Full-bleed on phones, a dashed card
 * from tablets up. The buttons open the real file inputs, so Enter and Space just work.
 */
export function Dropzone({
  over,
  coarse,
  mac,
  engine,
  onPick,
  onSnap,
  onIntent,
}: {
  over: boolean;
  coarse: boolean;
  mac: boolean;
  /** Decides the size quoted for the first download; null until detection finishes. */
  engine: Engine | null;
  onPick: () => void;
  onSnap: () => void;
  /** First sign the person means it: warms the model. */
  onIntent: () => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") onIntent();
  };
  return (
    <section
      role="region"
      aria-label="Add a photo"
      data-over={over || undefined}
      className={cn(
        "flex min-h-[calc(100dvh-6rem)] flex-1 flex-col items-center justify-center border-dashed border-border-strong bg-surface px-6 text-center transition-colors duration-200 ease-quint",
        "max-sm:rounded-none max-sm:border-y sm:min-h-[calc(100dvh-7.75rem)] sm:rounded-lg sm:border",
        over && "border-accent bg-accent-soft",
      )}
    >
      <div className="flex w-full max-w-[520px] flex-col items-center animate-fade-in">
        <Logo className="size-10 text-fg-faint" />
        <h1 className="mt-5 text-[28px] font-semibold leading-[1.15] tracking-tight sm:text-[36px]">{SITE.tagline}</h1>
        <p className="mt-3 text-[15px] text-fg-muted">Nothing is uploaded. The model runs on your device.</p>
        <div className="mt-6 flex w-full max-w-[280px] flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
          <Button variant="primary" size="lg" onClick={onPick} onPointerDown={onIntent} onKeyDown={onKey}>
            <ImagePlus className="size-4" aria-hidden />
            Choose a photo
          </Button>
          {coarse && (
            <Button variant="secondary" size="lg" onClick={onSnap} onPointerDown={onIntent} onKeyDown={onKey}>
              <Camera className="size-4" aria-hidden />
              Take a photo
            </Button>
          )}
        </div>
        <p className={cn("relative mt-4 h-5 w-full text-[12.5px]", over ? "text-fg-muted" : "text-fg-faint")}>
          <span className={cn("absolute inset-x-0 whitespace-nowrap transition-opacity duration-150 ease-quint", over ? "opacity-0" : "opacity-100")}>
            <span className="sm:hidden">several at once is fine</span>
            <span className="hidden sm:inline">
              or drag it here · paste with <Kbd>{mac ? "⌘V" : "Ctrl V"}</Kbd>
            </span>
          </span>
          <span aria-hidden className={cn("absolute inset-x-0 whitespace-nowrap transition-opacity duration-150 ease-quint", over ? "opacity-100" : "opacity-0")}>
            drop it
          </span>
        </p>
        <p className={cn("mt-6 font-mono text-[12px]", over ? "text-fg-muted" : "text-fg-faint")}>First run downloads the model ({modelDownloadNote(engine)}). It is cached after that.</p>
      </div>
    </section>
  );
}
