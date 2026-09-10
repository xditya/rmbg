"use client";

import { Plus, Trash2, X } from "lucide-react";
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
}: {
  open: boolean;
  onClose: () => void;
  card: Card | null;
  onDoAnother: () => void;
  onRemove: () => void;
  onClearAll: () => void;
}) {
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
      </div>
      <div className="border-t border-border px-4 py-3">
        <Button size="lg" className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
