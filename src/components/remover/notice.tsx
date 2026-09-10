import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Card } from "@/hooks/use-queue";
import { cn } from "@/lib/cn";

const MESSAGES = {
  decode: "This format isn't supported by your browser. Try a JPEG or PNG.",
  model: "The model didn't download. Check your connection and try again.",
  inference: "Couldn't remove the background from this photo. Try again or use a different one.",
} as const;

/** The inline error under the stage for a failed card, with the actions that make sense for its error. */
export function Notice({ card, onRetry, onRemove, className }: { card: Card; onRetry: () => void; onRemove: () => void; className?: string }) {
  const error = card.error ?? "inference";
  return (
    <div role="alert" className={cn("flex items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-[13px]", className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <p className="min-w-0 flex-1 text-fg">{MESSAGES[error]}</p>
      <div className="flex shrink-0 gap-1.5">
        {error !== "decode" && (
          <Button size="sm" className="[@media(pointer:coarse)]:h-11" onClick={onRetry}>
            Try again
          </Button>
        )}
        {error !== "model" && (
          <Button size="sm" variant="ghost" className="[@media(pointer:coarse)]:h-11" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
