import { cn } from "@/lib/cn";

/**
 * The page-level "drop to add" veil, always mounted and faded with opacity while a drag is
 * over the document. `visibility` flips after the fade so the exit still plays and the
 * hidden backdrop-blur costs nothing while idle.
 */
export function DropOverlay({ open }: { open: boolean }) {
  return (
    <div
      aria-hidden
      data-open={open || undefined}
      className={cn(
        "pointer-events-none fixed inset-0 z-40 bg-bg/80 p-6 backdrop-blur-sm transition-[opacity,visibility] ease-quint",
        open ? "visible opacity-100 duration-200" : "invisible opacity-0 duration-150",
      )}
    >
      <div className="flex size-full items-center justify-center rounded-lg border-2 border-dashed border-accent text-[15px] text-fg">drop to add</div>
    </div>
  );
}
