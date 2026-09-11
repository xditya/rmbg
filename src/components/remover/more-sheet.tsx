"use client";

import { Plus, Trash2, X } from "lucide-react";
import type { EnginePreference } from "@/lib/remove";
import { Button } from "@/components/ui/button";
import { Dialog, sheetRow } from "@/components/ui/dialog";
import type { Card } from "@/hooks/use-queue";
import { cn } from "@/lib/cn";
import { EnginePicker } from "./engine-picker";

/** The phone "More" sheet: the secondary actions the bottom bar has no room for, and the engine choice. */
export function MoreSheet({
  open,
  onClose,
  card,
  onDoAnother,
  onRemove,
  onClearAll,
  enginePreference,
  onChooseEngine,
  onRedo,
}: {
  open: boolean;
  onClose: () => void;
  card: Card | null;
  onDoAnother: () => void;
  onRemove: () => void;
  onClearAll: () => void;
  enginePreference: EnginePreference;
  onChooseEngine: (next: EnginePreference) => void;
  /** Re-cuts the photo on the chosen engine; only offered when that would change something. */
  onRedo: (() => void) | null;
}) {
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Dialog open={open} onClose={onClose} title={card?.name ?? "Photo"} className="p-0">
      <div className="divide-y divide-border">
        <button type="button" className={cn(sheetRow, "text-fg")} onClick={run(onDoAnother)}>
          <Plus className="size-4 text-fg-muted" aria-hidden />
          Do another
        </button>
        <button type="button" className={cn(sheetRow, "text-danger")} onClick={run(onRemove)} disabled={!card}>
          <X className="size-4" aria-hidden />
          Remove this photo
        </button>
        <button type="button" className={cn(sheetRow, "text-fg")} onClick={run(onClearAll)}>
          <Trash2 className="size-4 text-fg-muted" aria-hidden />
          Clear all
        </button>
        {/* A setting, so choosing keeps the sheet open; Redo is an action and closes it, the stage shows the progress. */}
        <EnginePicker shape="list" value={enginePreference} onChange={onChooseEngine} onRedo={onRedo && run(onRedo)} />
      </div>
      <div className="border-t border-border px-4 py-3">
        <Button size="lg" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
