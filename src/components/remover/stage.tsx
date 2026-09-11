"use client";

import { useRef, useState, type CSSProperties } from "react";
import type { Card } from "@/hooks/use-queue";
import { cardStatus, isDownloading } from "@/hooks/use-queue";
import { useFitRect } from "@/hooks/use-fit-rect";
import type { Engine } from "@/lib/remove";
import { backdropColor, blurRadius, type BackdropChoice } from "@/lib/backdrop";
import { modelDownloadNote } from "@/lib/config";
import { formatDims, formatMB, formatMs, formatPx } from "@/lib/format";
import { lowMemory, maxEdge } from "@/lib/memory";
import { cn } from "@/lib/cn";
import { Compare } from "./compare";
import { ModelProgress } from "./model-progress";
import type { View } from "./view-switch";

export type Download = { loaded: number; total: number };

/** Plain words for the two engines: WebGPU runs on the graphics chip, WebAssembly on the processor. */
const ENGINE_LABEL: Record<Engine, string> = { webgpu: "Graphics chip", wasm: "Processor" };
/** The caption's tooltip: what the engine that cut this photo is, in a sentence. */
const ENGINE_HINT: Record<Engine, string> = { webgpu: "Cut on your graphics chip, the fast way.", wasm: "Cut on your processor. Slower, but it works on every device." };
/** The caption's tooltip on a scaled photo; the smaller edge of a low-memory visit says so (memory.ts). */
const downscaleNote = () => `Photos over ${formatPx(maxEdge())} on the long side are scaled down before the cut${lowMemory() ? " for this visit" : ""}.`;

/** The view that can actually be shown: anything but the original needs a finished cutout. */
export function effectiveView(card: Card | null, view: View): View {
  return card?.state === "done" && card.resultUrl ? view : "original";
}

/**
 * The selected photo at the largest size the box allows, fitted to its own aspect ratio.
 * Layers bottom to top: checker (the frame background), colour or blurred backdrop, the
 * cutout, the original (clipped to the left of `--x` in compare), then the handle.
 */
export function Stage({
  card,
  view,
  backdrop,
  engine,
  download,
  compare,
  onCompare,
  waitingForModel,
  firstRun,
  className,
}: {
  card: Card;
  view: View;
  backdrop: BackdropChoice;
  engine: Engine | null;
  /** Bytes loaded so far while the model downloads (the card's own, or the shared preload). */
  download: Download | null;
  compare: number;
  onCompare: (v: number) => void;
  waitingForModel: boolean;
  /** Whether this download is the first one (the note about caching is shown). */
  firstRun: boolean;
  className?: string;
}) {
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const { box, rect } = useFitRect(area, card.width, card.height);

  const v = effectiveView(card, view);
  const done = v !== "original";
  // The view we came from: Compare -> Result keeps the clip while the original fades out, so
  // the right half never flashes the full original before the cross-fade.
  const [views, setViews] = useState({ prev: v, cur: v });
  if (views.cur !== v) setViews({ prev: views.cur, cur: v });
  const clipped = v === "compare" || (v === "result" && views.prev === "compare");
  const color = backdropColor(backdrop);
  const rw = card.resultWidth ?? card.width ?? 1;
  const blurPx = rect ? (blurRadius(rw, card.resultHeight ?? card.height ?? 1) * rect.width) / rw : 0;

  const frameStyle: CSSProperties | undefined = rect ? { width: rect.width, height: rect.height } : undefined;
  const preMeta: CSSProperties | undefined = !rect && box ? { maxWidth: box.width, maxHeight: box.height } : undefined;

  return (
    <div
      className={cn(
        // svh, not dvh: phone browser bars retract during a scroll and a dvh box would resize under the thumb.
        "flex flex-col bg-surface-2 max-sm:h-[min(54svh,520px)] max-sm:min-h-[280px] max-sm:border-b max-sm:border-border",
        // The minimum gives way on short viewports (a phone held sideways) so the controls stay on screen.
        "sm:h-[clamp(200px,62svh,640px)] sm:min-h-[min(360px,calc(100svh-9rem))] sm:overflow-hidden sm:rounded-lg sm:border sm:border-border lg:h-[calc(100dvh-7.75rem)] lg:min-h-[480px]",
        className,
      )}
    >
      <div ref={area} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-3 sm:p-6">
        <div
          ref={frame}
          data-dragging={dragging || undefined}
          className={cn("group/frame relative select-none overflow-hidden rounded-md bg-checker ring-1 ring-border/60", !rect && !box && "invisible")}
          style={frameStyle}
        >
          {rect ? (
            <>
              {done && (
                <>
                  <div
                    aria-hidden
                    className={cn("absolute inset-0 transition-opacity duration-200 ease-quint", color ? "opacity-100" : "opacity-0")}
                    style={color ? { backgroundColor: color } : undefined}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset */}
                  <img
                    src={card.originalUrl}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className={cn("absolute inset-0 size-full scale-110 object-cover transition-opacity duration-200 ease-quint", backdrop.kind === "blur" ? "opacity-100" : "opacity-0")}
                    style={{ filter: `blur(${blurPx}px)` }}
                  />
                </>
              )}
              {card.state === "done" && card.resultUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset
                <img
                  src={card.resultUrl}
                  alt={`${card.name}, background removed`}
                  aria-hidden={!done || undefined}
                  draggable={false}
                  className={cn("absolute inset-0 size-full object-contain transition-opacity duration-200 ease-quint", done ? "animate-fade-in opacity-100 [animation-duration:240ms]" : "opacity-0")}
                />
              )}
              {/* eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset */}
              <img
                src={card.originalUrl}
                alt={card.name}
                aria-hidden={v === "result" || undefined}
                draggable={false}
                className={cn("absolute inset-0 size-full object-contain transition-opacity duration-200 ease-quint", v === "result" ? "opacity-0" : "opacity-100")}
                style={clipped ? { clipPath: "inset(0 calc(100% - var(--x, 50%)) 0 0)" } : undefined}
              />
              {v === "compare" && (
                <>
                  <Pill side="left">original</Pill>
                  <Pill side="right">result</Pill>
                  <Compare frameRef={frame} value={compare} onChange={onCompare} onDragging={setDragging} />
                </>
              )}
              {card.state === "loading-model" &&
                (isDownloading(download) ? (
                  <ModelProgress mode="determinate" loaded={download?.loaded} total={download?.total} />
                ) : (
                  <ModelProgress mode="indeterminate" label="Starting the model" />
                ))}
              {card.state === "removing" && <ModelProgress mode="indeterminate" />}
            </>
          ) : (
            // Before the dimensions are known: let the image size itself inside the box.
            // eslint-disable-next-line @next/next/no-img-element -- object URL, not an asset
            <img src={card.originalUrl} alt={card.name} draggable={false} className="block object-contain" style={preMeta} />
          )}
        </div>
      </div>
      <div className="hidden h-8 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 font-mono text-[12px] text-fg-faint sm:flex">
        <StatusLine card={card} engine={engine} download={download} waitingForModel={waitingForModel} firstRun={firstRun} withName />
      </div>
    </div>
  );
}

function Pill({ side, children }: { side: "left" | "right"; children: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute bottom-2 rounded bg-bg/80 px-1.5 py-0.5 font-mono text-[11px] text-fg backdrop-blur transition-opacity duration-200 ease-quint group-data-[dragging]/frame:opacity-0 group-data-[dragging]/frame:duration-150",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Two mono spans: what is happening on the left, the numbers on the right. Rendered in the
 * stage footer on tablets and desktops and in its own row under the stage on phones. Once a
 * card is done (or failed) the left side names the engine that cut it, in plain words; the
 * engine is chosen elsewhere (the picker in the column, the toolbar or the More sheet).
 */
export function StatusLine({
  card,
  engine,
  download,
  waitingForModel,
  firstRun,
  withName,
}: {
  card: Card;
  engine: Engine | null;
  download: Download | null;
  waitingForModel: boolean;
  firstRun?: boolean;
  withName?: boolean;
}) {
  const known = card.engine ?? engine;
  /** The engine named on the left once the card has run (done or failed). */
  let used: Engine | null = null;
  let left = "";
  let right = "";
  let title: string | undefined;
  switch (card.state) {
    case "loading-model":
      // Once the bytes have landed (at once, from the cache, on a repeat visit) the session is
      // being created; that is not a download and is not the first run.
      if (!isDownloading(download)) {
        left = "starting the model";
        right = withName ? card.name : "";
        break;
      }
      // The first-run note lives here, where the row already has the room, so nothing shifts.
      left = firstRun ? (withName ? "downloading model · first run, cached after this" : "downloading model · first run") : "downloading model";
      right = download && download.total > 0 ? formatMB(download.loaded, download.total) : modelDownloadNote(known);
      break;
    case "removing":
      // Without WebGPU the library runs the model on the main thread, so the page really does pause.
      left = known === "wasm" ? "removing… the page may pause for a few seconds" : "removing background…";
      right = withName ? card.name : "";
      break;
    case "queued":
      left = cardStatus(card, waitingForModel);
      right = withName ? card.name : "";
      break;
    case "failed":
      used = known;
      right = withName ? `${card.name} · failed` : "failed";
      break;
    case "done": {
      used = known ?? "wasm";
      const src = card.width && card.height ? formatDims(card.width, card.height) : "";
      const out = card.resultWidth && card.resultHeight ? formatDims(card.resultWidth, card.resultHeight) : "";
      const scaled = src && out && src !== out;
      const dims = scaled ? `${src} → ${out}` : out || src;
      right = [withName ? card.name : "", dims, card.ms !== undefined ? formatMs(card.ms) : ""].filter(Boolean).join(" · ");
      if (scaled) title = downscaleNote();
      break;
    }
  }
  if (used) left = ENGINE_LABEL[used];
  return (
    <>
      {/* On phones the right side is short or empty, so the left may shrink there; elsewhere the name yields. */}
      <span className="shrink-0 truncate max-sm:min-w-0 max-sm:shrink" title={used ? ENGINE_HINT[used] : undefined} data-engine={used ?? undefined}>
        {left}
      </span>
      <span className="ml-auto min-w-0 truncate text-right" title={title}>
        {right}
      </span>
    </>
  );
}
