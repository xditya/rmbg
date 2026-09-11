"use client";

import { Check, Cpu, Plus, Trash2, X } from "lucide-react";
import type { EnginePreference } from "@/lib/remove";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { Card } from "@/hooks/use-queue";
import { cn } from "@/lib/cn";

const row = "flex h-12 w-full items-center gap-3 px-4 text-left text-[15px] transition-colors active:bg-surface-2";

/** The phone "More" sheet: the secondary actions the bottom bar has no room for. */
export function MoreSheet({
  open,
  onClose,
  card,
  onDoAnother,
  onRemove,
  onClearAll,
  enginePreference,
  onToggleEngine,
}: {
  open: boolean;
  onClose: () => void;
  card: Card | null;
  onDoAnother: () => void;
  onRemove: () => void;
  onClearAll: () => void;
  enginePreference: EnginePreference;
  onToggleEngine: () => void;
}) {
  const wasm = enginePreference === "wasm";
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Dialog open={open} onClose={onClose} title={card?.name ?? "Photo"} className="p-0">
      <div className="divide-y divide-border">
        <button type="button" className={cn(row, "text-fg")} onClick={run(onDoAnother)}>
          <Plus className="size-4 text-fg-muted" aria-hidden />
          Do another
        </button>
        <button type="button" className={cn(row, "text-danger")} onClick={run(onRemove)} disabled={!card}>
          <X className="size-4" aria-hidden />
          Remove this photo
        </button>
        <button type="button" className={cn(row, "text-fg")} onClick={run(onClearAll)}>
          <Trash2 className="size-4 text-fg-muted" aria-hidden />
          Clear all
        </button>
        {/* Stays open: the row is a setting, and the tick shows the state; the notice still confirms it. */}
        <button type="button" role="switch" aria-checked={wasm} className={cn(row, "h-auto min-h-14 py-2 text-fg")} onClick={onToggleEngine}>
          <Cpu className="size-4 shrink-0 text-fg-muted" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>Always use the processor</span>
            <span className="text-[12.5px] text-fg-muted">{wasm ? "On. Slower, but the cutout is right on every device." : "Off. Your graphics chip does the cut when it can, which is much faster."}</span>
          </span>
          <span
            aria-hidden
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ease-quint",
              wasm ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface text-transparent",
            )}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        </button>
      </div>
      <div className="border-t border-border px-4 py-3">
        <Button size="lg" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
