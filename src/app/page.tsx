import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { Remover } from "@/components/remover/remover";
import { LIMITS, modelDownloadNote, SITE } from "@/lib/config";
import { formatPx, formatWholeMB } from "@/lib/format";

export const metadata: Metadata = {
  title: `${SITE.name} — ${SITE.tagline}`,
  description: SITE.description,
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <Shell mobile>
      <Remover />
      <About />
    </Shell>
  );
}

/** Plain words under the tool, server-rendered so search engines and no-JS visitors read them too. */
function About() {
  return (
    <section className="mx-auto mt-8 w-full max-w-[560px] text-[13px] leading-6 text-fg-muted max-sm:px-4">
      <h2 className="mb-1 font-mono text-[12px] text-fg-faint">what it is</h2>
      <p>
        rmbg cuts the subject out of a photo and gives you a PNG with a transparent, plain or blurred backdrop. Drop one photo or thirty; each one is done on your
        device by a model that runs in the browser, so nothing is sent anywhere. PNG, JPEG, WebP, GIF, BMP and AVIF work, up to {formatWholeMB(LIMITS.maxBytes)} each;
        photos over {formatPx(LIMITS.maxEdge)} on the long side are scaled down first. The model is {modelDownloadNote(null)} depending on your browser and downloads
        once.
      </p>
      <h2 className="mb-1 mt-6 font-mono text-[12px] text-fg-faint">how it works</h2>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Choose a photo, drop it on the page, or paste one.</li>
        <li>The model finds the subject and cuts the background away, right here in the browser.</li>
        <li>Pick a backdrop and download the PNG, or copy it.</li>
      </ol>
      <p className="mt-6 font-mono text-[12px] text-fg-faint">
        nothing leaves your device · no accounts · no tracking ·{" "}
        <a href={SITE.repo} className="transition-colors hover:text-fg" rel="noopener noreferrer" target="_blank">
          source
        </a>
      </p>
    </section>
  );
}
