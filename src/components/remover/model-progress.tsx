/**
 * The 2px accent line along the bottom edge of the frame. Determinate while the model
 * downloads (scaleX, never width); indeterminate while the model runs. Under reduced
 * motion the sweep is replaced by a static half-opacity bar so the state stays visible.
 */
export function ModelProgress({ loaded = 0, total = 0, mode }: { loaded?: number; total?: number; mode: "determinate" | "indeterminate" }) {
  const determinate = mode === "determinate";
  const fraction = determinate && total > 0 ? Math.min(1, loaded / total) : 0;
  return (
    <div
      role="progressbar"
      aria-label={determinate ? "Model download" : "Removing background"}
      aria-valuemin={0}
      aria-valuemax={determinate ? total : undefined}
      aria-valuenow={determinate ? loaded : undefined}
      className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
    >
      {determinate ? (
        <div className="h-full w-full origin-left bg-accent transition-transform duration-200 ease-quint" style={{ transform: `scaleX(${fraction})` }} />
      ) : (
        <>
          <div className="h-full w-1/3 bg-accent animate-slide-x motion-reduce:hidden" />
          <div className="absolute inset-0 hidden bg-accent opacity-50 motion-reduce:block" />
        </>
      )}
    </div>
  );
}
