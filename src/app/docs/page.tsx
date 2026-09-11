import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { Shell } from "@/components/shell";
import { API, LIMITS, SITE } from "@/lib/config";
import { formatPx, formatWholeMB } from "@/lib/format";
import { perMinute, rateLimitDisabled } from "@/lib/server/ratelimit";

export const metadata: Metadata = {
  title: "API",
  description: `Remove backgrounds over plain HTTP: curl, fetch, Python, or a shell loop. No keys, no accounts, nothing stored.`,
  alternates: { canonical: "/docs" },
};

/** The API caps requests lower than the page does, since the page never uploads. */
const API_MAX_BYTES = LIMITS.apiMaxBytes;
const MAX_MP = Math.round(LIMITS.apiMaxPixels / 1e6);

function Code({ children }: { children: string }) {
  return (
    <pre className="code mt-3 overflow-x-auto rounded-lg border border-border bg-surface px-4 py-3 text-[12.5px] leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mt-10 scroll-mt-16 text-[16px] font-semibold tracking-tight first:mt-0">
      <a href={`#${id}`} className="hover:underline">
        {children}
      </a>
    </h2>
  );
}

function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`mt-2 text-[13px] leading-6 text-fg-muted ${className ?? ""}`}>{children}</p>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-fg">{children}</span>;
}

export default async function DocsPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const HOST = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || `${proto}://${host}`;
  const ENDPOINT = `${HOST}${API.path}`;
  // This instance's limit, not the compiled-in default: the operator may have changed or dropped it.
  const RATE_PER_MIN = rateLimitDisabled() ? null : perMinute();
  const AUTH = process.env.API_KEY ? "bearer" : "none";

  return (
    <Shell tagline="held in memory for the request · nothing is stored">
      <div className="mx-auto w-full max-w-3xl min-w-0 py-10">
        <h1 className="text-[24px] font-semibold tracking-tight">API</h1>
        <p className="mt-2 text-[14px] leading-6 text-fg-muted">
          Everything the page does is available over plain HTTP. No keys, no accounts, nothing stored. One difference: the page runs the model in your browser,
          the API runs it on the server. So the photo is uploaded, held in memory for the length of the request, and gone when the response is sent. If that
          matters for a photo, use the page, which never uploads.
        </p>

        <H2 id="quick">Plain curl</H2>
        <P>
          Send the bytes, get the cutout back. Options travel in the query string. Terminal clients get errors as one line of text; everything else gets JSON.
        </P>
        <Code>{`# Raw body in, PNG with a transparent backdrop out
curl --data-binary @photo.jpg -H 'Content-Type: image/jpeg' ${ENDPOINT} -o photo-rmbg.png

# A form works too; with ?download its filename names the file
curl -F image=@photo.jpg ${ENDPOINT} -o photo-rmbg.png

# Flat backdrop: white, black, or any hex colour
curl --data-binary @photo.jpg -H 'Content-Type: image/jpeg' '${ENDPOINT}?bg=white' -o photo-white.png
curl --data-binary @photo.jpg -H 'Content-Type: image/jpeg' '${ENDPOINT}?bg=1a2b3c' -o photo-navy.png

# The original, blurred, behind the subject; smaller as WebP
curl --data-binary @photo.jpg -H 'Content-Type: image/jpeg' '${ENDPOINT}?bg=blur&format=webp' -o photo-blur.webp

# Ask for a download header, so a browser or wget picks the file name
curl -OJ --data-binary @photo.jpg -H 'Content-Type: image/jpeg' '${ENDPOINT}?download&name=portrait'`}</Code>

        <H2 id="request">Request</H2>
        <P>
          One endpoint. The body is the image, raw or in a form. PNG, JPEG, WebP, GIF, AVIF and TIFF are read; the type is sniffed from the bytes, so the{" "}
          <Mono>Content-Type</Mono> header is a courtesy, not a contract.
        </P>
        <Code>{`POST /api/v1/remove
Content-Type: image/jpeg               raw bytes in the body
Content-Type: multipart/form-data      field "image" (or "file"); options may be fields too

Options (query string, or form fields)
  bg        transparent          default; PNG with alpha
            white | black        flat backdrop
            1a2b3c | #fff        any hex colour, with or without the #
            blur                 the original, blurred, behind the subject
  format    png | webp           default png; webp is quality ${API.webpQuality}
  download  (flag)               adds Content-Disposition: attachment; filename="<stem>-rmbg.png" (.webp for webp)
  name      photo                the stem for that file name; without it the multipart file name is used
  plain     (flag)               errors as text/plain, whatever the client

Authorization: Bearer <key>            only on instances that set API_KEY; the public one has no keys`}</Code>

        <H2 id="response">Response</H2>
        <P>The image bytes, nothing wrapped around them. The size is the input size, unless the photo was scaled down first (see limits).</P>
        <Code>{`200 OK
Content-Type: image/png                image/webp with format=webp
Content-Length: 412884
Cache-Control: no-store
X-Engine: ${API.engine}
X-Duration-Ms: 1840                    model time on the server, for your own timing
X-Image-Size: 1600x1200                width x height of the result
Access-Control-Allow-Origin: *         so a browser on any site can call it
Content-Disposition: attachment; filename="photo-rmbg.png"     only with ?download`}</Code>

        <H2 id="examples">Examples</H2>
        <P>
          In a browser. The API allows any origin, so this runs from a page on another domain too. <Mono>file</Mono> is a <Mono>File</Mono> from an input or a
          drop; the result is a <Mono>Blob</Mono> you can show or save.
        </P>
        <Code>{`const res = await fetch("${ENDPOINT}?bg=white", {
  method: "POST",
  headers: { "Content-Type": file.type },
  body: file,
});
if (!res.ok) throw new Error((await res.json()).error.message);
const blob = await res.blob();
img.src = URL.createObjectURL(blob);
console.log(res.headers.get("X-Duration-Ms"), "ms on the server");`}</Code>
        <P>In Node 18 or newer, with the built-in fetch. Nothing to install.</P>
        <Code>{`import { readFile, writeFile } from "node:fs/promises";

const photo = await readFile("photo.jpg");
const res = await fetch("${ENDPOINT}?format=webp", {
  method: "POST",
  headers: { "Content-Type": "image/jpeg" },
  body: photo,
});
if (!res.ok) {
  const { error } = await res.json();
  throw new Error(\`\${error.code}: \${error.message}\`);
}
await writeFile("photo-rmbg.webp", Buffer.from(await res.arrayBuffer()));`}</Code>
        <P>In Python, with requests. A multipart upload, so the file name rides along.</P>
        <Code>{`import requests

with open("photo.jpg", "rb") as f:
    r = requests.post(
        "${ENDPOINT}",
        params={"bg": "blur"},
        files={"image": ("photo.jpg", f, "image/jpeg")},
        timeout=60,
    )

if r.status_code == 429:
    print("rate limited, retry in", r.headers.get("Retry-After"), "s")
r.raise_for_status()
with open("photo-rmbg.png", "wb") as out:
    out.write(r.content)`}</Code>
        <P>
          A folder at a time. The loop below writes <Mono>name-rmbg.png</Mono> next to every jpg and keeps going when one fails. Ten a minute is the limit on the
          public instance, so the <Mono>sleep</Mono> stays under it.
        </P>
        <Code>{`for f in *.jpg; do
  curl -sS --fail --data-binary "@$f" -H 'Content-Type: image/jpeg' \\
    '${ENDPOINT}?bg=white' -o "\${f%.jpg}-rmbg.png" \\
    && echo "done  $f" || echo "failed  $f"
  sleep 6
done`}</Code>

        <H2 id="limits">Limits &amp; errors</H2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13px] leading-6 text-fg-muted">
          <li>
            One image per request, up to {formatWholeMB(API_MAX_BYTES)}. Bigger bodies get 413: at once when the Content-Length says so, else the moment the
            stream passes the limit. (The page takes up to{" "}
            {formatWholeMB(LIMITS.maxBytes)}, because it never uploads.)
          </li>
          <li>
            Photos over {formatPx(LIMITS.maxEdge)} on the long side are scaled down first, so the result is at most that size. Over {MAX_MP} megapixels they
            are refused with 413 instead, before the model sees them. EXIF rotation is applied; the result is upright.
          </li>
          <li>
            {RATE_PER_MIN === null ? (
              <>No rate limit on this instance. Elsewhere the default is {API.ratePerMinute} requests a minute per IP.</>
            ) : (
              <>{RATE_PER_MIN} requests a minute per IP.</>
            )}{" "}
            Over that you get 429 with a <Mono>Retry-After</Mono> header, in seconds. The limit counts requests, not successes; a 415 costs the same as a
            cutout.
          </li>
          <li>
            A run takes two to five seconds on the server for a typical photo, and the server caps a request at {API.maxDuration} seconds. At most{" "}
            {API.concurrency} run at once per instance; a burst queues, and when the queue is over {API.maxQueue} deep you get 503 with <Mono>Retry-After: 5</Mono> rather than a long wait.
          </li>
          <li>
            Errors are <Mono>{'{ "error": { "code", "message" } }'}</Mono> with the matching status. Clients that look like a terminal (curl, wget, httpie, xh)
            get <Mono>error: message (code)</Mono> as text instead; force either with <Mono>Accept: application/json</Mono>, <Mono>Accept: text/plain</Mono> or{" "}
            <Mono>?plain</Mono>. Every error also carries the code in an <Mono>X-Error-Code</Mono> header.
          </li>
        </ul>
        <Code>{`400  invalid            the body could not be decoded, or bg / format is not one of the listed values
401  unauthorized       the instance wants a key and the Bearer token is missing or wrong
413  too_large          more than ${formatWholeMB(API_MAX_BYTES)}, or more than ${MAX_MP} megapixels
415  unsupported_type   the bytes are not an image the server can read
429  rate_limited       over ${RATE_PER_MIN ?? "the limit"} a minute from this IP; Retry-After says when
503  busy               the queue is full; Retry-After: 5
500  engine             the model didn't answer; try again in a moment
500  internal_error     something else went wrong; try again`}</Code>

        <H2 id="privacy">What the server keeps</H2>
        <P>
          Nothing of the photo. It is decoded in memory, run through the model, composited, and streamed back; it is never written to disk, never cached, and its
          bytes are never logged. A failure logs one line with the error class, not the input. The only state that outlives a request is the rate limiter: a
          counter per IP (per /64 for IPv6) that expires after a minute, in the process&apos;s memory by default, or in Redis when the operator configured one.
        </P>
        <P>
          No analytics, no third-party scripts, no cookies. Responses carry <Mono>Cache-Control: no-store</Mono>, pages carry{" "}
          <Mono>Referrer-Policy: no-referrer</Mono> and a nonce-based Content Security Policy that lets the page talk only to itself and the model CDN. That is
          what the code does; it is not a promise about a network between you and the server. For a photo that must not leave your machine, the page is the
          answer: it runs the same model in the browser and uploads nothing.
        </P>

        <H2 id="self-host">Self-host</H2>
        <P>
          It is a plain Next.js app; the API is a route in it. Every variable is optional. The model weights (44 MB) are fetched once from imgly&apos;s CDN on the
          first request, checked against a pinned sha256, and cached under the system temp directory, so a warm instance answers in seconds. A mirror is
          checked chunk by chunk against its own manifest, and against <Mono>RMBG_MODEL_SHA256</Mono> when that is set.
        </P>
        <Code>{`API_KEY=                 lock the API: requests then need Authorization: Bearer <key>
RATE_LIMIT_PER_MIN=10    requests per minute per IP
DISABLE_RATE_LIMIT=1     no limiter at all (tests, a box behind your own auth)
UPSTASH_REDIS_REST_URL=  share the limiter across instances (Upstash; KV_REST_API_URL works too)
UPSTASH_REDIS_REST_TOKEN=
TRUSTED_PROXY_HOPS=1     proxies in front of the app that append X-Forwarded-For; 0 on Vercel, 1 elsewhere by default
RMBG_MODEL_URL=          base URL for the weights (a mirror, or an air-gapped copy of the CDN layout)
RMBG_MODEL_SHA256=       with a mirror, the sha256 the assembled model must hash to; the CDN's file is pinned in config
NEXT_PUBLIC_SITE_URL=    the public origin, for the URLs on this page`}</Code>
        <P>
          On Vercel the route declares a {API.maxDuration} second duration, which every plan allows: functions may run 300 seconds with Fluid Compute (on by
          default for new projects), and 60 on Hobby without it. A run needs two to five of those. The platform caps request bodies at 4.5 MB, below the{" "}
          {formatWholeMB(API_MAX_BYTES)} the route allows, and answers its own 413 for bigger uploads. The ONNX runtime and sharp are loaded from node_modules
          at run time rather than bundled; the function ships the linux binding plus <Mono>libonnxruntime.so.1</Mono> (about 45 MB with sharp) through{" "}
          <Mono>outputFileTracingIncludes</Mono> in <Mono>next.config.ts</Mono>, well under the 250 MB size limit.
        </P>

        <H2 id="info">Capabilities</H2>
        <P>What this instance allows, as JSON. Cached for a minute.</P>
        <Code>{`GET ${HOST}/api/v1/info

{
  "name": "${SITE.name}", "version": "…",
  "engine": "${API.engine}", "model": "${API.model}",
  "limits": { "maxBytes": ${API_MAX_BYTES}, "maxEdge": ${LIMITS.maxEdge}, "maxPixels": ${LIMITS.apiMaxPixels} },
  "backdrops": ${JSON.stringify(API.backdrops)},
  "formats": ${JSON.stringify(API.formats)},
  "rateLimit": { "perMinute": ${RATE_PER_MIN} },     null when the instance has no limit
  "auth": "${AUTH}"                       "bearer" on instances that set API_KEY
}`}</Code>
        <p className="mt-10 font-mono text-[12px] text-fg-faint">
          no keys · nothing stored ·{" "}
          <a href={SITE.repo} className="transition-colors hover:text-fg" rel="noopener noreferrer" target="_blank">
            source
          </a>
        </p>
      </div>
    </Shell>
  );
}
