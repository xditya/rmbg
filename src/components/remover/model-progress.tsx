import { useState } from "react";
import { formatMB } from "@/lib/format";

/**
 * The 2px accent line along the bottom edge of the frame. Determinate while the model
 * downloads (scaleX, never width); indeterminate while the model runs. Under reduced
 * motion the sweep is replaced by a static half-opacity bar so the state stays visible.
 * What is shown never moves backwards: the library reports per file and per chunk, and a
 * total that is revised upwards must not pull the bar back. A different total is a different
 * download (the WebAssembly fallback after WebGPU failed) and starts the bar over.
 */
export function ModelProgress({ loaded = 0, total = 0, mode }: { loaded?: number; total?: number; mode: "determinate" | "indeterminate" }) {
  const determinate = mode === "determinate";
  const fraction = determinate && total > 0 ? Math.min(1, loaded / total) : 0;
  const [shown, setShown] = useState({ mode, total, fraction });
  const fresh = shown.mode !== mode || shown.total !== total;
  if (fresh || fraction > shown.fraction) setShown({ mode, total, fraction });
  const shownFraction = fresh ? fraction : Math.max(shown.fraction, fraction);
  return (
    <div
      role="progressbar"
      aria-label={determinate ? "Model download" : "Removing background"}
      aria-valuemin={0}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(shownFraction * 100) : undefined}
      aria-valuetext={determinate && total > 0 ? formatMB(loaded, total) : undefined}
      className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
    >
      {determinate ? (
        <div className="h-full w-full origin-left bg-accent transition-transform duration-200 ease-quint" style={{ transform: `scaleX(${shownFraction})` }} />
      ) : (
        <>
          <div className="h-full w-1/3 bg-accent animate-slide-x motion-reduce:hidden" />
          <div className="absolute inset-0 hidden bg-accent opacity-50 motion-reduce:block" />
        </>
      )}
    </div>
  );
}
