import type { Metadata } from "next";
import Link from "next/link";
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
    <section className="mx-auto mt-8 w-full max-w-[560px] text-[13px] leading-6 text-fg-muted max-sm:px-4 max-sm:pb-6">
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
      <p className="mt-4">
        Under each finished photo you can see what did the cut. <strong className="font-medium text-fg">Graphics chip</strong> is the fast way and is used
        when your browser and device can do it. <strong className="font-medium text-fg">Processor</strong> is slower, a few seconds a photo, but it works
        everywhere. If a cutout looks wrong, tap that name and the next photo uses the processor instead; on phones the same switch is in More.
      </p>
      <p className="mt-4">
        Scripting it? The same cut is one HTTP call away: see{" "}
        <Link href="/docs" className="text-fg underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-fg">
          the API
        </Link>
        . That one runs the model on the server, so the photo is uploaded and held only for the length of the request.
      </p>
      <p className="mt-6 font-mono text-[12px] text-fg-faint">
        nothing leaves your device · no accounts · no tracking ·{" "}
        <a href={SITE.repo} className="transition-colors hover:text-fg" rel="noopener noreferrer" target="_blank">
          source
        </a>
      </p>
    </section>
  );
}
