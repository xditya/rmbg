"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useEngine } from "@/hooks/use-engine";
import { isMac, useHotkeys, type Hotkey } from "@/hooks/use-hotkeys";
import { useClientFact } from "@/hooks/use-media";
import { isDownloading, useQueue } from "@/hooks/use-queue";
import { TRANSPARENT, type BackdropChoice } from "@/lib/backdrop";
import type { EnginePreference } from "@/lib/remove";
import { LIMITS, LOW_MEMORY_EDGE, SITE } from "@/lib/config";
import { formatBytes, formatDims, formatMs, formatPx, formatWholeMB } from "@/lib/format";
import { clearInflight, crashedRun, dismissCrash, markInflight, subscribeCrash } from "@/lib/memory";
import { cn } from "@/lib/cn";
import { ActionButtons, PhoneBar, useActions } from "./action-bar";
import { BackgroundPicker } from "./background-picker";
import { DropOverlay } from "./drop-overlay";
import { Dropzone } from "./dropzone";
import { canRedo, EnginePicker } from "./engine-picker";
import { MoreSheet } from "./more-sheet";
import { InfoNotice, Notice } from "./notice";
import { Queue } from "./queue";
import { effectiveView, Stage, StatusLine } from "./stage";
import { ViewSwitch, type View } from "./view-switch";

const DEFAULT_TITLE = `${SITE.name} — ${SITE.tagline}`;
const SIZE_LIMIT = formatWholeMB(LIMITS.maxBytes);

/** How long an announcement stays in the live region; same-batch ones each get their own node. */
const ANNOUNCE_MS = 2000;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

const VIEW_RADIO = '[role="radiogroup"][aria-label="View"] [aria-checked="true"]';

/** What the live region says when the engine choice changes (the picker itself shows no toast). */
const ENGINE_ANNOUNCE: Record<EnginePreference, string> = { wasm: "Engine: processor only.", auto: "Engine: automatic." };

/** How long a leaving row keeps its node (see use-queue); focus is checked again once it is gone. */
const EXIT_MS = 160;

/** What the crash guard says (memory.ts): the last document went away mid-run, so this visit works smaller. */
const LOW_MEMORY_NOTE = `The page reloaded while cutting the last photo, which usually means it ran out of memory. Photos are now scaled to ${formatPx(LOW_MEMORY_EDGE)} before the cut for this visit.`;
const LOW_MEMORY_AGAIN = "If it keeps happening, pick Processor only under engine.";

/** Focuses the first match that is actually rendered: the phone controls and the desktop column both carry a view switch. */
function focusVisible(root: HTMLElement | null, selector: string): void {
  Array.from(root?.querySelectorAll<HTMLElement>(selector) ?? [])
    .find((el) => el.getClientRects().length > 0)
    ?.focus();
}

/** Whether nothing useful has focus (the focused control was unmounted, or nothing was focused). */
const focusLost = () => document.activeElement === document.body || document.activeElement === null;

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
  const heroPick = useRef<HTMLButtonElement>(null);
  const viewChosen = useRef(false);
  const selectedRef = useRef<string | null>(null);
  /** Cards that finished while another was on the stage; each gets its Compare reveal when first selected. */
  const unrevealed = useRef(new Set<string>());
  const wasEmpty = useRef(true);
  /** How the person last interacted; decides whether focus is moved for them. */
  const modality = useRef<"pointer" | "keyboard">("pointer");

  const [view, setView] = useState<View>("original");
  const [backdrop, setBackdrop] = useState<BackdropChoice>(TRANSPARENT);
  const [compare, setCompare] = useState(50);
  const [depth, setDepth] = useState(0);
  const [more, setMore] = useState(false);
  const [live, setLive] = useState<{ n: number; text: string; at: number }[]>([]);
  const [reveal, setReveal] = useState<string | null>(null);
  const [firstRunShown, setFirstRunShown] = useState(false);

  const mac = useClientFact(isMac, false);

  const announce = useCallback((text: string) => {
    const at = Date.now();
    setLive((l) => [...l.filter((x) => at - x.at < ANNOUNCE_MS), { n: (l[l.length - 1]?.n ?? 0) + 1, text, at }]);
  }, []);

  const engine = useEngine({
    onDownload: (phase, pct) => announce(phase === "start" ? "Downloading the model" : phase === "end" ? "Model downloaded" : `Model ${pct}% downloaded`),
  });

  /** The Compare-at-50 reveal, unless the person has picked a view themselves. */
  const revealCard = useCallback((id: string) => {
    if (!viewChosen.current) {
      setView("compare");
      setCompare(50);
    }
    setReveal(id);
  }, []);

  const queue = useQueue({
    ensureModel: engine.ensure,
    modelReady: engine.isReady,
    // Right after a WebGPU fallback too: `noteResult` has reported the engine by then.
    blocksMainThread: () => engine.engine !== "webgpu",
    currentEngine: () => engine.engine,
    onStart: (card) => announce(`Removing the background from ${card.name}`),
    onDone: (card, result) => {
      engine.noteResult(result.engine);
      announce(`${card.name} done in ${formatMs(result.ms)}`);
      // Only the card on the stage may move the view; a background finish waits for its first selection.
      if (card.id === selectedRef.current) revealCard(card.id);
      else unrevealed.current.add(card.id);
    },
    onFail: (card) => announce(`Couldn't remove the background from ${card.name}`),
  });
  const { cards, selected, selectedId, counts, modelFailed, add, select, remove, clear, retry, redo } = queue;
  const liveCards = useMemo(() => cards.filter((c) => !c.leaving), [cards]);
  // Leaving cards still count here so the queue stays mounted while their exit plays.
  const multi = cards.length >= 2;
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
        push("error", rejected.notImage.length ? "That file isn't an image. PNG, JPEG, WebP, GIF, BMP and AVIF work." : `${rejected.tooBig[0]} is over ${SIZE_LIMIT}. Try a smaller copy.`);
      } else if (n > 1) {
        push("error", `${n} files were skipped. Only images under ${SIZE_LIMIT} work.`);
      }
      if (rejected.overCap > 0) push("info", `Added the first ${LIMITS.maxFiles}. Drop the rest after.`);
      if (added.length === 1) announce(`Added ${added[0].name}`);
      else if (added.length > 1) announce(`Added ${added.length} photos`);
    },
    [add, announce, intent, push],
  );

  const openPicker = useCallback(() => pickRef.current?.click(), []);
  const openCamera = useCallback(() => snapRef.current?.click(), []);

  // Remove and Try again unmount the control they were fired from, which would leave focus on
  // <body> and the hotkeys dead; the view switch takes it once the node is gone (a leaving row
  // keeps its node for EXIT_MS, hence the second look). The empty state is handled below.
  const keepFocus = useCallback(() => {
    const settle = () => {
      if (focusLost()) focusVisible(root.current, VIEW_RADIO);
    };
    requestAnimationFrame(settle);
    setTimeout(settle, EXIT_MS + 40);
  }, []);

  const removeCard = useCallback(
    (id: string) => {
      const card = cards.find((c) => c.id === id && !c.leaving);
      if (!card) return;
      unrevealed.current.delete(id);
      remove(id);
      announce(`Removed ${card.name}`);
      keepFocus();
    },
    [cards, remove, announce, keepFocus],
  );

  const clearAll = useCallback(() => {
    unrevealed.current.clear();
    viewChosen.current = false;
    clear();
    announce("Cleared");
  }, [clear, announce]);

  const retryCard = useCallback(
    (id: string) => {
      retry(id);
      keepFocus();
    },
    [retry, keepFocus],
  );

  /** Runs the selected photo again on the engine the preference now implies; the reveal repeats when it lands. */
  const redoCard = useCallback(
    (id: string) => {
      unrevealed.current.delete(id);
      redo(id);
      keepFocus();
    },
    [redo, keepFocus],
  );

  const chooseEngine = useCallback(
    (next: EnginePreference) => {
      if (next === engine.preference) return;
      engine.setPreference(next);
      announce(ENGINE_ANNOUNCE[next]);
    },
    [engine, announce],
  );

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

  // The crash guard: a mark left by the last document means it went away mid-run (a phone
  // out of memory reloads the page blank); this visit works at a smaller size and says so.
  // A deliberate leave takes the mark with it; a page back from the cache mid-run restores it.
  const crash = useSyncExternalStore(subscribeCrash, crashedRun, () => null);
  const memoryNote = crash ? (crash.repeat ? `${LOW_MEMORY_NOTE} ${LOW_MEMORY_AGAIN}` : LOW_MEMORY_NOTE) : null;
  const busy = counts.loading || counts.removing;
  const busyRef = useRef(busy);
  const engineRef = useRef(engine.engine);
  useEffect(() => {
    busyRef.current = busy;
    engineRef.current = engine.engine;
  }, [busy, engine.engine]);
  useEffect(() => {
    const onHide = () => clearInflight();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && busyRef.current) markInflight(engineRef.current);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // Input modality, tracked once so focus is only moved for keyboard users.
  useEffect(() => {
    const onPointer = () => (modality.current = "pointer");
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) modality.current = "keyboard";
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

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

  // Bare keys only fire while focus is inside the tool (the root is focusable, so a click on
  // the stage keeps it there); the destructive pair needs the modifier.
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
      { combo: "mod+backspace", handler: () => selectedId && removeCard(selectedId) },
      { combo: "mod+delete", handler: () => selectedId && removeCard(selectedId) },
    ],
    [actions, openPicker, chooseView, step, selectedId, removeCard],
  );
  useHotkeys(hotkeys, { within: root });

  const download = selected?.progress ?? engine.download;
  // The phase comes from the bytes, not the clock: on a cached load they all land within a
  // few hundred ms and the rest of loading-model is the session starting, not a download.
  const downloading = isDownloading(download);

  // The tab title follows the queue, on transitions only.
  useEffect(() => {
    const { total, done, failed, loading, removing } = counts;
    document.title = loading
      ? `${downloading ? "downloading" : "starting"} the model · ${SITE.name}`
      : removing
        ? `removing ${Math.min(total, done + failed + 1)} of ${total} · ${SITE.name}`
        : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [counts, downloading]);

  // The first-run note waits 300ms so cached weights never flash it.
  const loadingSelected = selected?.state === "loading-model";
  useEffect(() => {
    if (!loadingSelected || firstRunShown) return;
    const t = setTimeout(() => setFirstRunShown(true), 300);
    return () => clearTimeout(t);
  }, [loadingSelected, firstRunShown]);
  const firstRun = firstRunShown && loadingSelected && !engine.ready && downloading;

  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId && unrevealed.current.delete(selectedId)) revealCard(selectedId);
  }, [selectedId, revealCard]);

  // Adding the first photo unmounts the hero, and removing the last one unmounts the stage,
  // each with whatever was focused. Keyboard and screen-reader users land on the view switch
  // or the hero button instead of the top of the document. A fresh queue may reveal again.
  useEffect(() => {
    const was = wasEmpty.current;
    wasEmpty.current = empty;
    if (empty === was) return;
    if (empty) viewChosen.current = false;
    if (modality.current !== "keyboard" && !focusLost()) return;
    if (empty) heroPick.current?.focus();
    else focusVisible(root.current, VIEW_RADIO);
  }, [empty]);

  // After the reveal, keyboard users land on the slider; pointer users are left alone.
  useEffect(() => {
    if (!reveal || reveal !== selectedId || modality.current !== "keyboard") return;
    focusVisible(root.current, '[role="slider"]');
  }, [reveal, selectedId]);

  const shownView = effectiveView(selected, view);
  const done = selected?.state === "done";
  const waitingForModel = !!selected && selected.state === "queued" && counts.loading;
  const removeHint = mac ? "⌘ Backspace" : "Ctrl Backspace";
  // The selected card's own error, else the model failure that is holding the whole queue.
  const notice = selected?.state === "failed" ? selected : modelFailed;
  // "Redo this photo" only while the selected card's cut and the engine choice disagree.
  const onRedo = selected && canRedo(selected, engine.preference, engine.detected) ? () => redoCard(selected.id) : null;

  return (
    <div ref={root} tabIndex={-1} className={cn("relative flex flex-1 flex-col outline-none", !empty && "lg:flex-row lg:gap-4")}>
      <input
        ref={pickRef}
        id="pick"
        type="file"
        multiple
        accept={LIMITS.accept.join(",")}
        aria-hidden
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
        aria-hidden
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          if (e.currentTarget.files?.length) addFiles(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <div aria-live="polite" className="sr-only">
        {live.map((l) => (
          <span key={l.n}>{l.text}</span>
        ))}
      </div>

      {empty || !selected ? (
        <>
          {memoryNote && <InfoNotice message={memoryNote} onDismiss={dismissCrash} className="mb-3 max-sm:mx-4 max-sm:mt-3" />}
          <Dropzone over={depth > 0} mac={mac} engine={engine.engine} onPick={openPicker} onSnap={openCamera} onIntent={intent} pickRef={heroPick} />
        </>
      ) : (
        <>
          {/* The hero's heading leaves with it; heading navigation still needs one for the tool. */}
          <h1 className="sr-only">{SITE.tagline}</h1>
          <div className="flex min-w-0 flex-1 flex-col animate-fade-in">
            {memoryNote && <InfoNotice message={memoryNote} onDismiss={dismissCrash} className="mb-3 max-sm:mx-4 max-sm:mb-2 max-sm:mt-3" />}
            <Stage
              card={selected}
              view={view}
              backdrop={backdrop}
              engine={engine.engine}
              download={download}
              compare={compare}
              onCompare={setCompare}
              waitingForModel={waitingForModel}
              firstRun={firstRun}
            />
            <div className="flex h-8 items-center gap-3 px-4 font-mono text-[12px] text-fg-faint sm:hidden">
              <StatusLine card={selected} engine={engine.engine} download={download} waitingForModel={waitingForModel} firstRun={firstRun} />
            </div>
            {notice && <Notice card={notice} onRetry={() => retryCard(notice.id)} onRemove={() => removeCard(notice.id)} className="max-sm:mx-4 max-sm:my-2 sm:mt-2" />}

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
                <ActionButtons
                  actions={actions}
                  layout="row"
                  onDoAnother={openPicker}
                  trailing={
                    <Button
                      variant="danger"
                      className="ml-auto border-transparent bg-transparent [@media(pointer:coarse)]:h-11"
                      aria-label={`Remove ${selected.name}`}
                      title={`Remove (${removeHint})`}
                      onClick={() => removeCard(selected.id)}
                    >
                      Remove
                    </Button>
                  }
                />
                {/* The tablet toolbar's last row: the engine choice, its control sized like the view switch above it. */}
                <EnginePicker shape="segmented" inline value={engine.preference} onChange={chooseEngine} onRedo={onRedo} className="w-full" />
              </div>
            </div>
            {multi && (
              <Queue
                cards={cards}
                selectedId={selectedId}
                download={engine.download}
                onSelect={select}
                onRemove={removeCard}
                onAdd={openPicker}
                onClearAll={clearAll}
                layout="strip"
                // Padding pulled back by margins: the scroll box needs room for the 2px-offset focus ring.
                className="-mt-1 animate-fade-in px-4 pb-3 pt-1.5 scroll-px-4 sm:-mx-1.5 sm:-mb-1.5 sm:mt-1.5 sm:px-1.5 sm:pb-1.5 sm:scroll-px-1.5 lg:hidden"
              />
            )}
          </div>

          {/* Bound to the viewport like the stage (and not stretched to the row), so the queue list scrolls instead of the page. */}
          <aside className="hidden w-[320px] shrink-0 flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface animate-fade-in lg:flex lg:h-[calc(100dvh-7.75rem)] lg:min-h-[480px] lg:self-start">
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
              <EnginePicker shape="segmented" value={engine.preference} onChange={chooseEngine} onRedo={onRedo} />
            </div>
            <div className="px-4 py-3">
              <p className="mb-2 text-[12px] text-fg-faint">background</p>
              <BackgroundPicker value={backdrop} onChange={setBackdrop} previewUrl={selected.thumbUrl ?? selected.originalUrl} disabled={!done} size="md" className="gap-2" />
            </div>
            {multi && (
              <Queue cards={cards} selectedId={selectedId} download={engine.download} onSelect={select} onRemove={removeCard} onAdd={openPicker} onClearAll={clearAll} layout="list" className="animate-fade-in" />
            )}
            <div className="mt-auto px-4 py-2">
              <Button variant="danger" size="sm" className="w-full border-transparent bg-transparent" title={`Remove (${removeHint})`} onClick={() => removeCard(selected.id)}>
                Remove this photo
              </Button>
            </div>
          </aside>

          <DropOverlay open={depth > 0} />
          <PhoneBar actions={actions} onMore={() => setMore(true)} moreOpen={more} />
          <MoreSheet
            open={more}
            onClose={() => setMore(false)}
            card={selected}
            onDoAnother={openPicker}
            onRemove={() => removeCard(selected.id)}
            onClearAll={clearAll}
            enginePreference={engine.preference}
            onChooseEngine={chooseEngine}
            onRedo={onRedo}
          />
        </>
      )}
    </div>
  );
}
