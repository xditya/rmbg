import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { Remover } from "@/components/remover/remover";
import { SITE } from "@/lib/config";

export const metadata: Metadata = {
  title: `${SITE.name} — ${SITE.tagline}`,
  description: SITE.description,
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <Shell className="max-sm:px-0 max-sm:py-0">
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
        device by a small open model, so nothing is sent anywhere. PNG, JPEG, WebP, GIF, BMP and AVIF work, up to 25 MB each. The model is about 40 MB and downloads
        once.
      </p>
      <h2 className="mb-1 mt-6 font-mono text-[12px] text-fg-faint">how it works</h2>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Choose a photo, drop it on the page, or paste one.</li>
        <li>The model finds the subject and cuts the background away, right here in the browser.</li>
        <li>Pick a backdrop and download the PNG, or copy it.</li>
      </ol>
      <p className="mt-6 font-mono text-[12px] text-fg-faint">nothing leaves your device · no accounts · no tracking</p>
    </section>
  );
}
