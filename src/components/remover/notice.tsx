import { CircleAlert, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Card } from "@/hooks/use-queue";
import { cn } from "@/lib/cn";

const MESSAGES = {
  decode: "This format isn't supported by your browser. Try a JPEG or PNG.",
  model: "The model didn't download. Check your connection and try again.",
  engine: "The model couldn't start in this browser. Try a current Chrome, Edge, Firefox or Safari.",
  inference: "Couldn't remove the background from this photo. Try again or use a different one.",
} as const;

const box = "flex items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-[13px] animate-fade-up max-sm:flex-wrap";
const actions = "flex shrink-0 gap-1.5 max-sm:basis-full max-sm:justify-end";

/**
 * The inline error under the stage for a failed card, with the actions that make sense for its
 * error: everything but a format failure can be retried (a model that would not download or
 * start is re-initialised from scratch), and the card that holds the queue is not removed here.
 */
export function Notice({ card, onRetry, onRemove, className }: { card: Card; onRetry: () => void; onRemove: () => void; className?: string }) {
  const error = card.error ?? "inference";
  return (
    <div role="alert" className={cn(box, className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <p className="min-w-0 flex-1 text-fg">{MESSAGES[error]}</p>
      <div className={actions}>
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

/** The same box for a note about the visit rather than a card (the crash guard), with one way out. */
export function InfoNotice({ message, onDismiss, className }: { message: string; onDismiss: () => void; className?: string }) {
  return (
    <div role="alert" data-notice="info" className={cn(box, className)}>
      <Info className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
      <p className="min-w-0 flex-1 text-fg">{message}</p>
      <div className={actions}>
        <Button size="sm" variant="ghost" className="[@media(pointer:coarse)]:h-11" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
