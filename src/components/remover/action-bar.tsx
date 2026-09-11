"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, Ellipsis, Plus, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { BarButton, MobileBar } from "@/components/ui/mobile-bar";
import { useToast } from "@/components/ui/toast";
import { useClientFact } from "@/hooks/use-media";
import type { Card } from "@/hooks/use-queue";
import { backdropKey, toBackdrop, type BackdropChoice } from "@/lib/backdrop";
import { canCopyImages, canShareFiles, copyPng, saveBlob, sharePng } from "@/lib/download";
import { resultName } from "@/lib/format";
import { composeBackdrop } from "@/lib/remove";
import { cn } from "@/lib/cn";

type Cached = { id: string; key: string; promise: Promise<Blob> };

/**
 * Download, copy and share for the selected card. The PNG is composed lazily on the first
 * action and cached for that card and backdrop; a transparent backdrop is the cutout itself.
 */
export function useActions(card: Card | null, choice: BackdropChoice) {
  const { push } = useToast();
  const cache = useRef<Cached | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canCopy = useClientFact(canCopyImages, false);
  const canShare = useClientFact(canShareFiles, false);
  const ready = !!card && card.state === "done" && !!card.resultBlob;

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (busyTimer.current) clearTimeout(busyTimer.current);
    },
    [],
  );

  /** Runs an action; the button only shows its spinner when the compose takes a while, so a cached PNG never flashes it. */
  const busy = useCallback(async (work: () => Promise<void>) => {
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setComposing(true), 250);
    try {
      await work();
    } finally {
      if (busyTimer.current) clearTimeout(busyTimer.current);
      busyTimer.current = null;
      setComposing(false);
    }
  }, []);

  const compose = useCallback((): Promise<Blob> | null => {
    if (!card || card.state !== "done") return null;
    const { resultBlob, resultWidth, resultHeight, file } = card;
    if (!resultBlob || !resultWidth || !resultHeight) return null;
    const key = backdropKey(choice);
    if (cache.current && cache.current.id === card.id && cache.current.key === key) return cache.current.promise;
    const backdrop = toBackdrop(choice, resultWidth, resultHeight);
    const promise = backdrop.kind === "transparent" ? Promise.resolve(resultBlob) : Promise.resolve().then(() => composeBackdrop(resultBlob, file, backdrop));
    const entry: Cached = { id: card.id, key, promise };
    cache.current = entry;
    promise.catch(() => {
      if (cache.current === entry) cache.current = null;
    });
    return promise;
  }, [card, choice]);

  const download = useCallback(async () => {
    const p = compose();
    if (!p || !card) return;
    await busy(async () => {
      try {
        saveBlob(await p, resultName(card.name));
      } catch {
        push("error", "Couldn't compose the PNG. Try a different background.");
      }
    });
  }, [compose, card, push, busy]);

  const copy = useCallback(async () => {
    const p = compose();
    if (!p) return;
    await busy(async () => {
      try {
        // The promise form keeps Safari's gesture window alive while the PNG is composed.
        await copyPng(p);
        push("success", "Copied as PNG");
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      } catch {
        push("error", "Copy failed. Download it instead.");
      }
    });
  }, [compose, push, busy]);

  const share = useCallback(async () => {
    const p = compose();
    if (!p || !card) return;
    await busy(async () => {
      try {
        const blob = await p;
        await sharePng(new File([blob], resultName(card.name), { type: "image/png" }));
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) push("error", "Sharing didn't work. Download it instead.");
      }
    });
  }, [compose, card, push, busy]);

  return useMemo(() => ({ download, copy, share, canCopy, canShare, composing, copied, ready }), [download, copy, share, canCopy, canShare, composing, copied, ready]);
}

export type Actions = ReturnType<typeof useActions>;

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? <Check className="size-4 animate-fade-in text-success" aria-hidden /> : <Copy className="size-4 animate-fade-in" aria-hidden />;
}

/** Desktop column (stacked, with key hints) or tablet toolbar (a full-width row, with `trailing` pushed to its end). */
export function ActionButtons({
  actions,
  layout,
  onDoAnother,
  trailing,
}: {
  actions: Actions;
  layout: "column" | "row";
  onDoAnother: () => void;
  trailing?: ReactNode;
}) {
  const { download, copy, share, canCopy, canShare, composing, copied, ready } = actions;
  // Hidden from the accessible name (the `title` carries the key), so the button is not read as "Download PNG d".
  const hint = (k: string) => (
    <Kbd aria-hidden className="ml-auto hidden lg:inline-flex">
      {k}
    </Kbd>
  );
  // Tablets are touch screens too: the row's buttons match the 44px swatches beside them.
  const fit = cn(layout === "column" && "w-full", layout === "row" && "[@media(pointer:coarse)]:h-11");

  const primary = (
    <Button variant="primary" onClick={download} disabled={!ready} loading={composing} title="Download PNG (d)" className={fit}>
      <Download className="size-4" aria-hidden />
      Download PNG
      {layout === "column" && hint("d")}
    </Button>
  );
  const copyButton = canCopy ? (
    <Button key="copy" onClick={copy} disabled={!ready} title="Copy to clipboard (c)" className={fit}>
      <CopyIcon copied={copied} />
      Copy
      {layout === "column" && hint("c")}
    </Button>
  ) : null;
  const shareButton = canShare ? (
    <Button key="share" onClick={share} disabled={!ready} title="Share the PNG" className={fit}>
      <Share className="size-4" aria-hidden />
      Share
    </Button>
  ) : null;
  const another = (
    <Button key="another" variant="ghost" onClick={onDoAnother} title="Add another photo (n)" className={fit}>
      <Plus className="size-4" aria-hidden />
      Do another
      {layout === "column" && hint("n")}
    </Button>
  );

  if (layout === "row") {
    // A row of its own under the view switch and swatches, so the wrap is deliberate rather than ragged.
    return (
      <div className="flex w-full items-center gap-1.5">
        {primary}
        {copyButton}
        {shareButton}
        {another}
        {trailing}
      </div>
    );
  }

  // Column: the primary, then pairs in a grid, then anything left over full width.
  const rest: ReactNode[] = [copyButton, shareButton, another].filter(Boolean);
  const pair = rest.length >= 2 ? rest.slice(0, 2) : [];
  const tail = rest.length >= 2 ? rest.slice(2) : rest;
  return (
    <div className="flex flex-col gap-2">
      {primary}
      {pair.length > 0 && <div className="grid grid-cols-2 gap-1.5">{pair}</div>}
      {tail}
    </div>
  );
}

/** The fixed phone bar: Download, Copy and Share when the browser can, always More. */
export function PhoneBar({ actions, onMore, moreOpen }: { actions: Actions; onMore: () => void; moreOpen: boolean }) {
  const { download, copy, share, canCopy, canShare, copied, ready } = actions;
  return (
    <MobileBar label="Photo actions">
      <BarButton icon={<Download />} onClick={download} disabled={!ready}>
        Download
      </BarButton>
      {canCopy && (
        <BarButton icon={<CopyIcon copied={copied} />} onClick={copy} disabled={!ready}>
          Copy
        </BarButton>
      )}
      {canShare && (
        <BarButton icon={<Share />} onClick={share} disabled={!ready}>
          Share
        </BarButton>
      )}
      <BarButton icon={<Ellipsis />} onClick={onMore} aria-haspopup="dialog" aria-expanded={moreOpen}>
        More
      </BarButton>
    </MobileBar>
  );
}
