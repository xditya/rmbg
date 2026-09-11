"use client";

import { Check, CircleAlert, LoaderCircle, Plus, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { cardStatus, type Card, type Download } from "@/hooks/use-queue";
import { formatBytes, formatDims, formatMs } from "@/lib/format";
import { cn } from "@/lib/cn";

type Props = {
  cards: Card[];
  selectedId: string | null;
  /** The shared model download, shown on the card that is waiting for it (its own progress is empty then). */
  download?: Download | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onClearAll: () => void;
  layout: "list" | "strip";
  className?: string;
};

const stagger = (card: Card) => ({ animationDelay: `${Math.min(card.batch, 6) * 30}ms` });

function meta(card: Card, waiting: boolean): string {
  if (card.state === "done") {
    const dims = card.resultWidth && card.resultHeight ? formatDims(card.resultWidth, card.resultHeight) : "";
    return [formatBytes(card.size), dims, card.ms !== undefined ? formatMs(card.ms) : ""].filter(Boolean).join(" · ");
  }
  return cardStatus(card, waiting);
}

function stateWord(card: Card, waiting: boolean): string {
  return card.state === "done" ? "done" : cardStatus(card, waiting);
}

/** Two stacked thumbs: the original, and the cutout fading in over a checker once the card is done. */
function Thumb({ card, className }: { card: Card; className?: string }) {
  const result = card.resultThumbUrl ?? card.resultUrl;
  return (
    <span className={cn("block shrink-0 overflow-hidden bg-checker", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset */}
      <img src={card.thumbUrl ?? card.originalUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" draggable={false} />
      {card.state === "done" && result && (
        // eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset
        <img src={result} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover animate-fade-in [animation-duration:240ms]" draggable={false} />
      )}
    </span>
  );
}

/** The state as a shape as well as a colour: a tick, an alert, a spinner. Nothing while queued. */
function Glyph({ card, size = "size-4" }: { card: Card; size?: string }) {
  if (card.state === "done") return <Check className={cn(size, "text-success")} aria-hidden />;
  if (card.state === "failed") return <CircleAlert className={cn(size, "text-danger")} aria-hidden />;
  if (card.state === "loading-model" || card.state === "removing") return <LoaderCircle className={cn(size, "animate-spin text-fg-faint")} aria-hidden />;
  return <span className={cn("block", size)} aria-hidden />;
}

function header(cards: Card[]): string {
  const n = cards.length;
  const done = cards.filter((c) => c.state === "done").length;
  if (done === 0) return `queue · ${n}`;
  if (done === n) return "queue · all done";
  return `queue · ${done} of ${n} done`;
}

/**
 * The queue, only rendered once there are two or more photos: a hairline list in the desktop
 * column, a thumbnail strip under the stage on tablets and phones. Both end with an add tile.
 */
export function Queue({ cards: rows, selectedId, download, onSelect, onRemove, onAdd, onClearAll, layout, className }: Props) {
  // The preload's progress lands on the engine, not the card; the waiting card borrows it.
  const cards = rows.map((c) => (c.state === "loading-model" && !c.progress && download ? { ...c, progress: download } : c));
  const live = cards.filter((c) => !c.leaving);
  const waiting = live.some((c) => c.state === "loading-model");

  if (layout === "strip") {
    return (
      <div className={cn("flex items-center gap-2 overflow-x-auto snap-x", className)} role="group" aria-label="Queue">
        {/* The exit relies on plain opacity/transform, so the entrance animation is dropped once a card leaves. */}
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            aria-label={`${card.name}, ${stateWord(card, waiting)}`}
            aria-current={card.id === selectedId || undefined}
            data-leaving={card.leaving || undefined}
            onClick={() => onSelect(card.id)}
            style={stagger(card)}
            className={cn(
              "relative size-16 shrink-0 snap-start overflow-hidden rounded-md ring-1 ring-border transition-[opacity,transform] duration-150 ease-quint active:scale-[.97] sm:size-20",
              !card.leaving && "animate-fade-up",
              "aria-[current=true]:ring-2 aria-[current=true]:ring-accent data-[leaving]:-translate-y-1 data-[leaving]:opacity-0",
            )}
          >
            <Thumb card={card} className="absolute inset-0" />
            {card.state !== "queued" && (
              <span aria-hidden className="absolute bottom-1 right-1 flex size-5 items-center justify-center rounded-full bg-surface ring-1 ring-border">
                <Glyph card={card} size="size-3" />
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          aria-label="Add photos"
          onClick={onAdd}
          className="flex size-16 shrink-0 snap-start items-center justify-center rounded-md border border-dashed border-border-strong text-fg-muted transition-[border-color,color,transform] duration-200 ease-quint hover:border-accent hover:text-fg active:scale-[.97] sm:size-20"
        >
          <Plus className="size-4" aria-hidden />
        </button>
        {/* Phones have Clear all in the More sheet; a wrapper hides it here because the Button's own display class would win. */}
        <span className="ml-1 hidden shrink-0 sm:contents">
          <Button size="sm" variant="ghost" className="[@media(pointer:coarse)]:h-11" onClick={onClearAll}>
            Clear all
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-9 shrink-0 items-center px-4 text-[12px] text-fg-faint">
        <span>{header(live)}</span>
        <Button size="sm" variant="ghost" onClick={onClearAll} className="ml-auto -mr-2">
          Clear all
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Queue">
        {cards.map((card) => {
          const running = card.state === "loading-model" || card.state === "removing";
          const pct = card.state === "loading-model" && card.progress && card.progress.total > 0 ? card.progress.loaded / card.progress.total : null;
          return (
            <li
              key={card.id}
              data-leaving={card.leaving || undefined}
              style={stagger(card)}
              className={cn("group relative transition-[opacity,transform] duration-150 ease-quint data-[leaving]:-translate-y-1 data-[leaving]:opacity-0", !card.leaving && "animate-fade-up")}
            >
              <button
                type="button"
                aria-current={card.id === selectedId || undefined}
                onClick={() => onSelect(card.id)}
                className="flex h-14 w-full items-center gap-3 px-4 pr-12 text-left transition-colors hover:bg-surface-2/60 focus-visible:-outline-offset-2 active:bg-surface-2 aria-[current=true]:bg-surface-2"
              >
                <Thumb card={card} className="relative size-10 rounded-sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">{card.name}</span>
                  <span className="truncate font-mono text-[12px] text-fg-muted">{meta(card, waiting)}</span>
                </span>
                <Glyph card={card} />
              </button>
              <IconButton
                size="sm"
                label={`Remove ${card.name}`}
                onClick={() => onRemove(card.id)}
                className="absolute right-2 top-1/2 -translate-y-1/2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
              >
                <X className="size-4" />
              </IconButton>
              {running && (
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                  {pct !== null ? (
                    <span className="block h-full w-full origin-left bg-accent transition-transform duration-200 ease-quint" style={{ transform: `scaleX(${pct})` }} />
                  ) : (
                    <>
                      <span className="block h-full w-1/3 bg-accent animate-slide-x motion-reduce:hidden" />
                      <span className="absolute inset-0 hidden bg-accent opacity-50 motion-reduce:block" />
                    </>
                  )}
                </span>
              )}
            </li>
          );
        })}
        <li>
          <button
            type="button"
            aria-label="Add photos"
            onClick={onAdd}
            className="flex h-12 w-full items-center gap-3 px-4 text-[13px] text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:-outline-offset-2 active:bg-surface-2"
          >
            <span className="flex size-10 items-center justify-center rounded-sm border border-dashed border-border-strong">
              <Plus className="size-4" aria-hidden />
            </span>
            Do another
          </button>
        </li>
      </ul>
    </div>
  );
}
