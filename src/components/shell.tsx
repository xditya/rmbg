import Link from "next/link";
import type { ReactNode } from "react";
import { SITE } from "@/lib/config";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/cn";

/**
 * App chrome: a slim top bar, a content slot that fills the viewport, a one-line footer.
 * `mobile` is for pages with a fixed bottom bar on phones: the content goes full-bleed, <main>
 * pads above the bar while one is rendered and the footer is dropped (its link lives in the
 * page text instead). `tagline` replaces the footer's promise on pages where it is not true as
 * written (the API docs).
 */
export function Shell({
  children,
  actions,
  className,
  mobile,
  tagline = "runs on your device · nothing is uploaded",
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  mobile?: boolean;
  tagline?: string;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 rounded-md text-[14px] font-semibold tracking-tight text-fg" aria-label={`${SITE.name} home`}>
            <Logo className="size-5" />
            <span>{SITE.name}</span>
          </Link>
          <nav className="ml-1 flex items-center gap-0.5" aria-label="Primary">
            <Link href="/docs" className="rounded-md px-2 py-1 text-[13.5px] font-medium text-fg-muted transition-colors hover:text-fg">
              api
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            {actions}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className={cn("mx-auto flex w-full max-w-6xl flex-1 flex-col px-3 py-3 sm:px-4 sm:py-4", mobile && "max-sm:px-0 max-sm:py-0 max-sm:has-[nav.fixed]:pb-bar", className)}>{children}</main>
      <footer className={cn(mobile ? "max-sm:hidden" : "max-sm:pb-safe")}>
        <div className="mx-auto flex w-full max-w-6xl items-center gap-x-4 px-4 py-3 font-mono text-[12px] text-fg-faint">
          <Link href="/docs" className="transition-colors hover:text-fg">
            api
          </Link>
          <a href={SITE.repo} className="transition-colors hover:text-fg" rel="noopener noreferrer" target="_blank">
            source
          </a>
          <span className="ml-auto text-right">{tagline}</span>
        </div>
      </footer>
    </div>
  );
}
