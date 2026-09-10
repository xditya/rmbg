"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { LIMITS } from "@/lib/config";
import { removeBackground, type Engine, type RemoveResult } from "@/lib/remove";
import { makeThumb } from "@/lib/thumb";
import { formatBytes } from "@/lib/format";

export type CardState = "queued" | "loading-model" | "removing" | "done" | "failed";
export type CardError = "decode" | "model" | "inference";
export type Download = { loaded: number; total: number };

export type Card = {
  id: string;
  file: File;
  name: string;
  size: number;
  /** Position within the drop it arrived in, for the entrance stagger. */
  batch: number;
  width?: number;
  height?: number;
  originalUrl: string;
  thumbUrl?: string;
  /** 320px thumb of the cutout, so rows never decode the full result. */
  resultThumbUrl?: string;
  state: CardState;
  progress?: Download;
  resultUrl?: string;
  resultBlob?: Blob;
  resultWidth?: number;
  resultHeight?: number;
  ms?: number;
  engine?: Engine;
  error?: CardError;
  leaving?: boolean;
};

/** `paused` is set by a model download failure and only lasts while that failed card is still in the queue. */
type State = { cards: Card[]; selectedId: string | null; paused: boolean };

type Action =
  | { type: "add"; cards: Card[] }
  | { type: "thumb"; id: string; url: string | undefined; width: number; height: number }
  | { type: "resultThumb"; id: string; url: string }
  | { type: "select"; id: string }
  | { type: "remove"; id: string }
  | { type: "dropped"; id: string }
  | { type: "clear" }
  | { type: "start"; id: string; state: "loading-model" | "removing" }
  | { type: "progress"; id: string; progress: Download }
  | { type: "infer"; id: string }
  | { type: "done"; id: string; result: RemoveResult; url: string }
  | { type: "fail"; id: string; error: CardError }
  | { type: "retry"; id: string };

const initial: State = { cards: [], selectedId: null, paused: false };

function patch(cards: Card[], id: string, fn: (c: Card) => Card): Card[] {
  return cards.map((c) => (c.id === id ? fn(c) : c));
}

/** The neighbour that takes over selection when `id` goes: the next card, else the previous. */
function neighbour(cards: Card[], id: string): string | null {
  const live = cards.filter((c) => !c.leaving || c.id === id);
  const i = live.findIndex((c) => c.id === id);
  const next = live[i + 1] ?? live[i - 1];
  return next && next.id !== id ? next.id : null;
}

/** Whether the queue should stay paused: only while the card whose model download failed is still there. */
function stillPaused(state: State, cards: Card[]): boolean {
  return state.paused && cards.some((c) => c.state === "failed" && c.error === "model" && !c.leaving);
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case "add":
      // A fresh drop while paused is a retry: the new card triggers the download again.
      return { ...state, paused: false, cards: [...state.cards, ...a.cards], selectedId: state.selectedId ?? a.cards[0]?.id ?? null };
    case "thumb":
      return { ...state, cards: patch(state.cards, a.id, (c) => ({ ...c, thumbUrl: a.url ?? c.thumbUrl, width: a.width, height: a.height })) };
    case "resultThumb":
      return { ...state, cards: patch(state.cards, a.id, (c) => ({ ...c, resultThumbUrl: a.url })) };
    case "select":
      return state.cards.some((c) => c.id === a.id && !c.leaving) ? { ...state, selectedId: a.id } : state;
    case "remove": {
      if (!state.cards.some((c) => c.id === a.id && !c.leaving)) return state;
      const selectedId = state.selectedId === a.id ? neighbour(state.cards, a.id) : state.selectedId;
      const cards = patch(state.cards, a.id, (c) => ({ ...c, leaving: true }));
      return { ...state, selectedId, cards, paused: stillPaused(state, cards) };
    }
    case "dropped": {
      const cards = state.cards.filter((c) => c.id !== a.id);
      const selectedId = state.selectedId === a.id ? neighbour(state.cards, a.id) : state.selectedId;
      return { ...state, cards, selectedId, paused: stillPaused(state, cards) };
    }
    case "clear":
      return initial;
    case "start":
      return { ...state, cards: patch(state.cards, a.id, (c) => ({ ...c, state: a.state, progress: undefined, error: undefined })) };
    case "progress":
      return { ...state, cards: patch(state.cards, a.id, (c) => ({ ...c, state: "loading-model", progress: a.progress })) };
    case "infer":
      return { ...state, cards: patch(state.cards, a.id, (c) => ({ ...c, state: "removing", progress: undefined })) };
    case "done":
      return {
        ...state,
        cards: patch(state.cards, a.id, (c) => ({
          ...c,
          state: "done",
          progress: undefined,
          resultUrl: a.url,
          resultBlob: a.result.blob,
          resultWidth: a.result.width,
          resultHeight: a.result.height,
          ms: a.result.ms,
          engine: a.result.engine,
        })),
      };
    case "fail":
      return {
        ...state,
        paused: state.paused || a.error === "model",
        cards: patch(state.cards, a.id, (c) => ({ ...c, state: "failed", progress: undefined, error: a.error })),
      };
    case "retry":
      return { ...state, paused: false, cards: patch(state.cards, a.id, (c) => ({ ...c, state: "queued", error: undefined, progress: undefined })) };
  }
}

let counter = 0;
const nextId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

function revoke(card: Card) {
  URL.revokeObjectURL(card.originalUrl);
  if (card.thumbUrl) URL.revokeObjectURL(card.thumbUrl);
  if (card.resultUrl) URL.revokeObjectURL(card.resultUrl);
  if (card.resultThumbUrl) URL.revokeObjectURL(card.resultThumbUrl);
}

/** How long a leaving row keeps its node so the exit transition can play. */
const EXIT_MS = 160;

export type AddOutcome = { added: Card[]; rejected: { notImage: string[]; tooBig: string[]; overCap: number } };

/**
 * Anything the browser calls an image, plus files with no type at all (some file managers and
 * apps hand those over). The decoder decides for real: what it cannot read (HEIC on Chrome,
 * say) fails the card with the "format isn't supported" message instead of a wrong toast.
 */
const looksLikeImage = (f: File) => f.type.startsWith("image/") || f.type === "";

export type QueueOptions = {
  /** Resolves once the model is loaded; rejects when the download fails. */
  ensureModel: () => Promise<void>;
  /** Whether `ensureModel` would resolve immediately (skips the loading-model state). */
  modelReady: () => boolean;
  onDone?: (card: Card, result: RemoveResult) => void;
  onFail?: (card: Card, error: CardError) => void;
  onStart?: (card: Card) => void;
};

/**
 * The queue: a reducer for the cards plus one scheduler that runs a single job at a time.
 * Object URLs are revoked when a card is dropped, on clear and on unmount; a removed card's
 * job is aborted and its result ignored when it settles.
 */
export function useQueue(opts: QueueOptions) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [tick, setTick] = useState(0);
  const stateRef = useRef(state);
  const optsRef = useRef(opts);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Cards added while a job was running; decoded once it settles so the work never lands on a busy main thread. */
  const pending = useRef<Card[]>([]);

  useEffect(() => {
    stateRef.current = state;
    optsRef.current = opts;
  });

  const inQueue = useCallback((id: string) => stateRef.current.cards.some((c) => c.id === id && !c.leaving), []);

  // One decode per card: the thumbnail and the pixel size come from the same bitmap. A card
  // the browser cannot decode fails here with the "format isn't supported" message.
  const inspect = useCallback(
    (card: Card) => {
      makeThumb(card.file)
        .then(({ url, width, height }) => {
          if (inQueue(card.id)) dispatch({ type: "thumb", id: card.id, url, width, height });
          else if (url) URL.revokeObjectURL(url);
        })
        .catch(() => {
          if (!inQueue(card.id)) return;
          dispatch({ type: "fail", id: card.id, error: "decode" });
          optsRef.current.onFail?.(card, "decode");
        });
    },
    [inQueue],
  );

  const process = useCallback(async (card: Card) => {
    const ctrl = new AbortController();
    controllers.current.set(card.id, ctrl);
    running.current = card.id;
    const alive = () => controllers.current.get(card.id) === ctrl && !ctrl.signal.aborted;
    const { ensureModel, modelReady } = optsRef.current;
    try {
      dispatch({ type: "start", id: card.id, state: modelReady() ? "removing" : "loading-model" });
      optsRef.current.onStart?.(card);
      try {
        await ensureModel();
      } catch (e) {
        console.error("rmbg: the model didn't load", e);
        if (alive()) {
          dispatch({ type: "fail", id: card.id, error: "model" });
          optsRef.current.onFail?.(card, "model");
        }
        return;
      }
      if (!alive()) return;
      dispatch({ type: "infer", id: card.id });
      // The engine fits the photo to LIMITS.maxEdge itself and reports the size it used.
      const result = await removeBackground(card.file, {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (!alive()) return;
          if (p.kind === "download") dispatch({ type: "progress", id: card.id, progress: { loaded: p.loaded, total: p.total } });
          else dispatch({ type: "infer", id: card.id });
        },
      });
      if (!alive()) return;
      dispatch({ type: "done", id: card.id, result, url: URL.createObjectURL(result.blob) });
      optsRef.current.onDone?.(card, result);
      makeThumb(result.blob)
        .then(({ url }) => {
          if (!url) return;
          if (inQueue(card.id)) dispatch({ type: "resultThumb", id: card.id, url });
          else URL.revokeObjectURL(url);
        })
        .catch(() => {
          /* the row keeps the original thumb */
        });
    } catch (e) {
      if (!alive()) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error("rmbg: removal failed", e);
      dispatch({ type: "fail", id: card.id, error: "inference" });
      optsRef.current.onFail?.(card, "inference");
    } finally {
      if (controllers.current.get(card.id) === ctrl) controllers.current.delete(card.id);
      running.current = null;
      setTick((t) => t + 1);
    }
  }, [inQueue]);

  // The scheduler: whenever nothing is in flight, decode whatever arrived during the last job,
  // then start the first queued card whose dimensions are known (decode failures never get
  // this far). A card whose state says it is working counts as in flight even after its
  // promise settled: React can render the `start` update on its own before the `done`/`fail`
  // that followed it, and the ref alone would let a second job slip in during that
  // intermediate render.
  useEffect(() => {
    if (running.current) return;
    if (pending.current.length) {
      const batch = pending.current;
      pending.current = [];
      batch.forEach(inspect);
    }
    if (state.paused) return;
    if (state.cards.some((c) => c.state === "loading-model" || c.state === "removing")) return;
    const next = state.cards.find((c) => c.state === "queued" && !c.leaving && c.width !== undefined);
    if (next) void process(next);
  }, [state.cards, state.paused, tick, process, inspect]);

  const add = useCallback((input: FileList | File[]): AddOutcome => {
    const files = Array.from(input);
    const live = stateRef.current.cards.filter((c) => !c.leaving).length;
    const rejected = { notImage: [] as string[], tooBig: [] as string[], overCap: 0 };
    const accepted: File[] = [];
    for (const f of files) {
      if (!looksLikeImage(f)) rejected.notImage.push(f.name);
      else if (f.size > LIMITS.maxBytes) rejected.tooBig.push(f.name);
      else accepted.push(f);
    }
    const room = Math.max(0, LIMITS.maxFiles - live);
    rejected.overCap = Math.max(0, accepted.length - room);
    const cards: Card[] = accepted.slice(0, room).map((file, i) => ({
      id: nextId(),
      file,
      name: file.name || "photo",
      size: file.size,
      batch: i,
      originalUrl: URL.createObjectURL(file),
      state: "queued",
    }));
    if (cards.length) dispatch({ type: "add", cards });
    // On WebAssembly the inference holds the main thread, so decodes wait for the job to settle.
    if (running.current) pending.current.push(...cards);
    else cards.forEach(inspect);
    return { added: cards, rejected };
  }, [inspect]);

  const select = useCallback((id: string) => dispatch({ type: "select", id }), []);

  const remove = useCallback((id: string) => {
    const card = stateRef.current.cards.find((c) => c.id === id);
    if (!card || card.leaving) return;
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    dispatch({ type: "remove", id });
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        // The card as rendered now, not the click-time snapshot: a result or thumb that landed since is revoked too.
        revoke(stateRef.current.cards.find((c) => c.id === id) ?? card);
        dispatch({ type: "dropped", id });
      }, EXIT_MS),
    );
  }, []);

  const clear = useCallback(() => {
    for (const ctrl of controllers.current.values()) ctrl.abort();
    controllers.current.clear();
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    pending.current = [];
    stateRef.current.cards.forEach(revoke);
    dispatch({ type: "clear" });
  }, []);

  const retry = useCallback((id: string) => dispatch({ type: "retry", id }), []);

  // Unmount: abort everything and give the URLs back.
  useEffect(() => {
    const ctrls = controllers.current;
    const tms = timers.current;
    return () => {
      for (const ctrl of ctrls.values()) ctrl.abort();
      for (const t of tms.values()) clearTimeout(t);
      stateRef.current.cards.forEach(revoke);
    };
  }, []);

  const cards = useMemo(() => state.cards, [state.cards]);
  const selected = useMemo(() => cards.find((c) => c.id === state.selectedId && !c.leaving) ?? null, [cards, state.selectedId]);
  const counts = useMemo(() => {
    const live = cards.filter((c) => !c.leaving);
    return {
      total: live.length,
      done: live.filter((c) => c.state === "done").length,
      failed: live.filter((c) => c.state === "failed").length,
      loading: live.some((c) => c.state === "loading-model"),
      removing: live.some((c) => c.state === "removing"),
    };
  }, [cards]);

  /** The card whose model download failed, while it keeps the queue paused. */
  const modelFailed = useMemo(() => (state.paused ? (cards.find((c) => c.state === "failed" && c.error === "model" && !c.leaving) ?? null) : null), [cards, state.paused]);

  return { cards, selectedId: state.selectedId, selected, counts, paused: state.paused, modelFailed, add, select, remove, clear, retry };
}

export type QueueHandle = ReturnType<typeof useQueue>;

/** One line of row meta by state, shared by the list, the strip labels and the status line. */
export function cardStatus(card: Card, waitingForModel: boolean): string {
  switch (card.state) {
    case "queued":
      return waitingForModel ? "waiting for model" : "queued";
    case "loading-model":
      return card.progress && card.progress.total > 0 ? `downloading model · ${Math.round((card.progress.loaded / card.progress.total) * 100)}%` : "downloading model";
    case "removing":
      return "removing…";
    case "failed":
      return "failed";
    case "done":
      return formatBytes(card.size);
  }
}
