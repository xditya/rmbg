"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { IconButton } from "./button";

type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; message: string; leaving?: boolean };

/** How long a dismissed toast keeps its node so the exit can play. */
const EXIT_MS = 150;

const ToastContext = createContext<{ push: (kind: ToastKind, message: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    // Mark it leaving so it fades out, then drop it.
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((t) => t.filter((x) => x.id !== id));
      }, EXIT_MS),
    );
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++counter.current;
      setToasts((t) => [...t.slice(-3), { id, kind, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3200),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(clearTimeout);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 max-sm:bottom-auto max-sm:top-14">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            data-leaving={t.leaving || undefined}
            className="animate-fade-up pointer-events-auto flex max-w-md items-center gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[13px] shadow-pop transition-[opacity,transform] duration-150 ease-quint data-[leaving]:translate-y-1 data-[leaving]:opacity-0"
          >
            {t.kind === "success" && <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />}
            {t.kind === "error" && <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden />}
            {t.kind === "info" && <Info className="size-4 shrink-0 text-fg-muted" aria-hidden />}
            <span className="min-w-0 break-words">{t.message}</span>
            <IconButton size="sm" label="Dismiss" onClick={() => dismiss(t.id)} className="-my-1.5 -mr-1.5 ml-0.5 text-fg-faint">
              <X className="size-3.5" />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
