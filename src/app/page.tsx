import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { SITE } from "@/lib/config";

export const metadata: Metadata = {
  title: `${SITE.name} — ${SITE.tagline}`,
  description: SITE.description,
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <Shell>
      <p className="text-fg-muted">placeholder</p>
    </Shell>
  );
}
