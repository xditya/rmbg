"use client";

import { Check, CircleAlert, LoaderCircle, Plus, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { cardStatus, type Card } from "@/hooks/use-queue";
import { formatBytes, formatDims, formatMs } from "@/lib/format";
import { cn } from "@/lib/cn";

type Props = {
  cards: Card[];
  selectedId: string | null;
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

function Glyph({ card }: { card: Card }) {
  if (card.state === "done") return <Check className="size-4 text-success" aria-hidden />;
  if (card.state === "failed") return <CircleAlert className="size-4 text-danger" aria-hidden />;
  if (card.state === "loading-model" || card.state === "removing") return <LoaderCircle className="size-4 animate-spin text-fg-faint" aria-hidden />;
  return <span className="block size-4" aria-hidden />;
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
export function Queue({ cards, selectedId, onSelect, onRemove, onAdd, onClearAll, layout, className }: Props) {
  const live = cards.filter((c) => !c.leaving);
  const waiting = live.some((c) => c.state === "loading-model");

  if (layout === "strip") {
    return (
      <div className={cn("flex items-center gap-2 overflow-x-auto snap-x", className)} role="group" aria-label="Queue">
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
              "relative size-16 shrink-0 snap-start overflow-hidden rounded-md ring-1 ring-border transition-[opacity,transform] duration-150 ease-quint animate-fade-up sm:size-20",
              "aria-[current=true]:ring-2 aria-[current=true]:ring-accent data-[leaving]:-translate-y-1 data-[leaving]:opacity-0",
            )}
          >
            <Thumb card={card} className="absolute inset-0" />
            <span
              aria-hidden
              className={cn(
                "absolute bottom-1 right-1 size-2.5 rounded-full ring-2 ring-surface",
                card.state === "done" ? "bg-success" : card.state === "failed" ? "bg-danger" : card.state === "queued" ? "bg-fg-faint" : "bg-accent",
              )}
            />
          </button>
        ))}
        <button
          type="button"
          aria-label="Add photos"
          onClick={onAdd}
          className="flex size-16 shrink-0 snap-start items-center justify-center rounded-md border border-dashed border-border-strong text-fg-muted transition-colors hover:border-accent hover:text-fg sm:size-20"
        >
          <Plus className="size-4" aria-hidden />
        </button>
        <Button size="sm" variant="ghost" onClick={onClearAll} className="ml-1 hidden shrink-0 sm:inline-flex">
          Clear all
        </Button>
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
              className="group relative animate-fade-up transition-[opacity,transform] duration-150 ease-quint data-[leaving]:-translate-y-1 data-[leaving]:opacity-0"
            >
              <button
                type="button"
                aria-current={card.id === selectedId || undefined}
                onClick={() => onSelect(card.id)}
                className="flex h-14 w-full items-center gap-3 px-4 pr-12 text-left transition-colors hover:bg-surface-2/60 aria-[current=true]:bg-surface-2"
              >
                <Thumb card={card} className="relative size-10 rounded-sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">{card.name}</span>
                  <span className="truncate font-mono text-[12px] text-fg-faint">{meta(card, waiting)}</span>
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
          <button type="button" aria-label="Add photos" onClick={onAdd} className="flex h-12 w-full items-center gap-3 px-4 text-[13px] text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg">
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
