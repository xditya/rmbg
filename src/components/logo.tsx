/** A subject lifted off its backdrop: a solid dot over a dashed frame, drawn in the current color. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.75" strokeDasharray="3 2.5" />
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </svg>
  );
}
