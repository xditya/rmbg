"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useEngine } from "@/hooks/use-engine";
import { isMac, useHotkeys, type Hotkey } from "@/hooks/use-hotkeys";
import { useClientFact, useMedia } from "@/hooks/use-media";
import { useQueue } from "@/hooks/use-queue";
import { TRANSPARENT, type BackdropChoice } from "@/lib/backdrop";
import { LIMITS, SITE } from "@/lib/config";
import { formatBytes, formatDims, formatMs } from "@/lib/format";
import { cn } from "@/lib/cn";
import { ActionButtons, PhoneBar, useActions } from "./action-bar";
import { BackgroundPicker } from "./background-picker";
import { DropOverlay } from "./drop-overlay";
import { Dropzone } from "./dropzone";
import { MoreSheet } from "./more-sheet";
import { Notice } from "./notice";
import { Queue } from "./queue";
import { effectiveView, Stage, StatusLine } from "./stage";
import { ViewSwitch, type View } from "./view-switch";

const DEFAULT_TITLE = `${SITE.name} — ${SITE.tagline}`;
const FIRST_RUN = "First run downloads the model (about 40 MB). It is cached after that.";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

/**
 * The client root: owns the queue, the engine, the view and backdrop settings, the hidden
 * file inputs, document-level drop and paste, the hotkeys, the live region and the page
 * title. Renders the hero when the queue is empty and the stage layout otherwise.
 */
export function Remover() {
  const { push } = useToast();
  const root = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const snapRef = useRef<HTMLInputElement>(null);
  const viewChosen = useRef(false);

  const [view, setView] = useState<View>("original");
  const [backdrop, setBackdrop] = useState<BackdropChoice>(TRANSPARENT);
  const [compare, setCompare] = useState(50);
  const [depth, setDepth] = useState(0);
  const [more, setMore] = useState(false);
  const [live, setLive] = useState({ n: 0, text: "" });
  const [reveal, setReveal] = useState<string | null>(null);
  const [firstRunShown, setFirstRunShown] = useState(false);

  const coarse = useMedia("(pointer: coarse)");
  const mac = useClientFact(isMac, false);

  const announce = useCallback((text: string) => setLive((l) => ({ n: l.n + 1, text })), []);

  const engine = useEngine({
    onDownload: (phase) => announce(phase === "start" ? "Downloading the model" : "Model downloaded"),
  });

  const queue = useQueue({
    ensureModel: engine.ensure,
    modelReady: engine.isReady,
    onStart: (card) => announce(`Removing the background from ${card.name}`),
    onDone: (card, result) => {
      engine.noteResult(result.engine);
      announce(`Done. ${formatMs(result.ms)}`);
      if (!viewChosen.current) {
        setView("compare");
        setCompare(50);
      }
      setReveal(card.id);
    },
    onFail: (card) => announce(`Couldn't remove the background from ${card.name}`),
  });
  const { cards, selected, selectedId, counts, add, select, remove, clear, retry } = queue;
  const liveCards = useMemo(() => cards.filter((c) => !c.leaving), [cards]);
  const multi = liveCards.length >= 2;
  const empty = liveCards.length === 0;

  const intent = useCallback(() => {
    engine.ensure().catch(() => {
      /* surfaces on the card when it matters */
    });
  }, [engine]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      intent();
      const { added, rejected } = add(files);
      const n = rejected.notImage.length + rejected.tooBig.length;
      if (n === 1) {
        push("error", rejected.notImage.length ? "That file isn't an image. PNG, JPEG, WebP, GIF, BMP and AVIF work." : `${rejected.tooBig[0]} is larger than 25 MB, the limit.`);
      } else if (n > 1) {
        push("error", `${n} files were skipped. Only images under 25 MB work.`);
      }
      if (rejected.overCap > 0) push("info", `Added the first ${LIMITS.maxFiles}. Drop the rest after.`);
      if (added.length === 1) announce(`Added ${added[0].name}`);
      else if (added.length > 1) announce(`Added ${added.length} photos`);
    },
    [add, announce, intent, push],
  );

  const openPicker = useCallback(() => pickRef.current?.click(), []);
  const openCamera = useCallback(() => snapRef.current?.click(), []);

  const removeCard = useCallback(
    (id: string) => {
      const card = cards.find((c) => c.id === id && !c.leaving);
      if (!card) return;
      remove(id);
      announce(`Removed ${card.name}`);
    },
    [cards, remove, announce],
  );

  const clearAll = useCallback(() => {
    clear();
    announce("Cleared");
  }, [clear, announce]);

  const chooseView = useCallback(
    (v: View) => {
      if (v !== "original" && selected?.state !== "done") return;
      viewChosen.current = true;
      setView(v);
    },
    [selected?.state],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!selectedId || liveCards.length < 2) return;
      const i = liveCards.findIndex((c) => c.id === selectedId);
      const next = liveCards[(i + dir + liveCards.length) % liveCards.length];
      if (next) select(next.id);
    },
    [liveCards, selectedId, select],
  );

  const actions = useActions(selected, backdrop);

  // Document-level drag and paste. Depth counting keeps the overlay honest over nested nodes.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDepth((d) => d + 1);
      intent();
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      setDepth((d) => Math.max(0, d - 1));
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDepth(0);
      if (e.dataTransfer) addFiles(e.dataTransfer.files);
    };
    const reset = () => setDepth(0);
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      } else {
        push("info", "Nothing on the clipboard looks like an image.");
      }
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [addFiles, intent, push]);

  const hotkeys = useMemo<Hotkey[]>(
    () => [
      { combo: "d", handler: () => void actions.download() },
      { combo: "c", handler: () => void actions.copy() },
      { combo: "n", handler: openPicker },
      { combo: "1", handler: () => chooseView("original") },
      { combo: "2", handler: () => chooseView("result") },
      { combo: "3", handler: () => chooseView("compare") },
      { combo: "[", handler: () => step(-1) },
      { combo: "]", handler: () => step(1) },
      { combo: "backspace", handler: () => selectedId && removeCard(selectedId) },
      { combo: "delete", handler: () => selectedId && removeCard(selectedId) },
    ],
    [actions, openPicker, chooseView, step, selectedId, removeCard],
  );
  useHotkeys(hotkeys);

  // The tab title follows the queue, on transitions only.
  useEffect(() => {
    const { total, done, failed, loading, removing } = counts;
    document.title = loading ? `downloading the model · ${SITE.name}` : removing ? `removing ${Math.min(total, done + failed + 1)} of ${total} · ${SITE.name}` : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [counts]);

  // The first-run line waits 300ms so cached weights never flash it.
  const loadingSelected = selected?.state === "loading-model";
  useEffect(() => {
    if (!loadingSelected || firstRunShown) return;
    const t = setTimeout(() => setFirstRunShown(true), 300);
    return () => clearTimeout(t);
  }, [loadingSelected, firstRunShown]);
  const firstRunLine = firstRunShown && loadingSelected && !engine.ready;

  // After the reveal, keyboard users land on the slider; pointer users are left alone.
  useEffect(() => {
    if (!reveal || reveal !== selectedId) return;
    const active = document.activeElement;
    let keyboard = false;
    try {
      keyboard = active instanceof HTMLElement && active.matches(":focus-visible");
    } catch {
      keyboard = false;
    }
    if (keyboard) root.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
  }, [reveal, selectedId]);

  const shownView = effectiveView(selected, view);
  const done = selected?.state === "done";
  const download = selected?.progress ?? engine.download;
  const waitingForModel = !!selected && selected.state === "queued" && counts.loading;

  return (
    <div ref={root} className={cn("relative flex flex-1 flex-col", !empty && "max-sm:pb-bar lg:flex-row lg:gap-4")}>
      <input
        ref={pickRef}
        id="pick"
        type="file"
        multiple
        accept={LIMITS.accept.join(",")}
        aria-label="Choose a photo"
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          if (e.currentTarget.files?.length) addFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={snapRef}
        id="snap"
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take a photo"
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          if (e.currentTarget.files?.length) addFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <div aria-live="polite" className="sr-only">
        <span key={live.n}>{live.text}</span>
      </div>

      {empty || !selected ? (
        <Dropzone over={depth > 0} coarse={coarse} mac={mac} onPick={openPicker} onSnap={openCamera} onIntent={intent} />
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-col animate-fade-in">
            <Stage
              card={selected}
              view={view}
              backdrop={backdrop}
              engine={engine.engine}
              download={download}
              compare={compare}
              onCompare={setCompare}
              waitingForModel={waitingForModel}
            />
            <div className="flex h-8 items-center gap-3 px-4 font-mono text-[12px] text-fg-faint sm:hidden">
              <StatusLine card={selected} engine={engine.engine} download={download} waitingForModel={waitingForModel} />
            </div>
            {firstRunLine && <p className="text-[12.5px] text-fg-muted max-sm:px-4 max-sm:pb-2 sm:mt-2">{FIRST_RUN}</p>}
            {selected.state === "failed" && <Notice card={selected} onRetry={() => retry(selected.id)} onRemove={() => removeCard(selected.id)} className="max-sm:mx-4 max-sm:my-2 sm:mt-2" />}

            {/* Phone and tablet controls; the desktop column has its own. */}
            <div className="flex flex-col gap-3 px-4 py-3 sm:mt-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-0 sm:py-0 lg:hidden">
              <ViewSwitch value={shownView} onChange={chooseView} disabled={{ result: !done, compare: !done }} className="w-full sm:w-[264px]" />
              <BackgroundPicker
                value={backdrop}
                onChange={setBackdrop}
                previewUrl={selected.thumbUrl ?? selected.originalUrl}
                disabled={!done}
                size="auto"
                className="justify-center gap-3 sm:justify-start sm:gap-2"
              />
              <div className="hidden sm:contents">
                <ActionButtons actions={actions} layout="row" onDoAnother={openPicker} />
              </div>
            </div>
            {multi && (
              <Queue
                cards={cards}
                selectedId={selectedId}
                onSelect={select}
                onRemove={removeCard}
                onAdd={openPicker}
                onClearAll={clearAll}
                layout="strip"
                className="animate-fade-in px-4 pb-3 sm:mt-3 sm:px-0 sm:pb-0 lg:hidden"
              />
            )}
          </div>

          <aside className="hidden w-[320px] shrink-0 flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface animate-fade-in lg:flex">
            <div className="px-4 py-3">
              <p className="truncate text-[13px] font-medium">{selected.name}</p>
              <p className="font-mono text-[12px] text-fg-faint">
                {[selected.width && selected.height ? formatDims(selected.width, selected.height) : "", formatBytes(selected.size)].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex flex-col gap-2 px-4 py-3">
              <ViewSwitch value={shownView} onChange={chooseView} disabled={{ result: !done, compare: !done }} />
              <ActionButtons actions={actions} layout="column" onDoAnother={openPicker} />
            </div>
            <div className="px-4 py-3">
              <p className="mb-2 text-[12px] text-fg-faint">background</p>
              <BackgroundPicker value={backdrop} onChange={setBackdrop} previewUrl={selected.thumbUrl ?? selected.originalUrl} disabled={!done} size="md" className="gap-2" />
            </div>
            {multi && (
              <Queue cards={cards} selectedId={selectedId} onSelect={select} onRemove={removeCard} onAdd={openPicker} onClearAll={clearAll} layout="list" className="animate-fade-in" />
            )}
            <div className="mt-auto px-4 py-2">
              <Button variant="danger" size="sm" className="w-full border-transparent bg-transparent" title="Remove (Backspace)" onClick={() => removeCard(selected.id)}>
                Remove this photo
              </Button>
            </div>
          </aside>

          <DropOverlay open={depth > 0} />
          <PhoneBar actions={actions} onMore={() => setMore(true)} moreOpen={more} />
          <MoreSheet open={more} onClose={() => setMore(false)} card={selected} onDoAnother={openPicker} onRemove={() => removeCard(selected.id)} onClearAll={clearAll} />
        </>
      )}
    </div>
  );
}
