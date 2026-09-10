import { cn } from "@/lib/cn";

/** The page-level "drop to add" veil, always mounted and faded with opacity while a drag is over the document. */
export function DropOverlay({ open }: { open: boolean }) {
  return (
    <div
      aria-hidden
      data-open={open || undefined}
      className={cn(
        "pointer-events-none fixed inset-0 z-40 bg-bg/80 p-6 backdrop-blur-sm transition-opacity duration-150 ease-quint",
        open ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="flex size-full items-center justify-center rounded-lg border-2 border-dashed border-accent text-[15px] text-fg">drop to add</div>
    </div>
  );
}
