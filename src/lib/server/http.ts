/** Small HTTP helpers for the API routes, in the shape pastr uses. Server only. */
import { NextResponse } from "next/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers?: Record<string, string>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpError";
  }
}

/** The API is public: any origin may call it from a browser. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Expose-Headers": "Content-Disposition, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-Engine, X-Duration-Ms, X-Image-Size, X-Error-Code",
  "Access-Control-Max-Age": "86400",
};

export const NO_STORE: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

type Init = ResponseInit & { headers?: Record<string, string> };

export function json<T>(data: T, init: Init = {}) {
  return NextResponse.json(data, { ...init, headers: { ...CORS_HEADERS, ...NO_STORE, ...(init.headers ?? {}) } });
}

export function text(body: BodyInit, init: Init = {}) {
  return new NextResponse(body, {
    ...init,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS, ...NO_STORE, ...(init.headers ?? {}) },
  });
}

export function options() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * `{ "error": { "code", "message" } }`, or `error: message (code)` as text for terminals.
 * Logs one line per server-side failure with the error's class only; never the request.
 */
export function errorResponse(err: unknown, wantsText = false) {
  const e = err instanceof HttpError ? err : new HttpError(500, "internal_error", "Something went wrong. Try again in a moment.");
  if (e.status >= 500) {
    // The innermost cause: what actually failed (a fetch TypeError, an ORT Error), not the wrappers.
    let cause = err;
    while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
    console.error(`api: ${e.code} (${cause instanceof Error ? cause.name : typeof err})`);
  }
  const headers = { "X-Error-Code": e.code, ...(e.headers ?? {}) };
  if (wantsText) return text(`error: ${e.message} (${e.code})\n`, { status: e.status, headers });
  return json({ error: { code: e.code, message: e.message } }, { status: e.status, headers });
}

/**
 * The rate-limit key for an address. An IPv6 host is handed a /64 at least, so the key is that
 * prefix, else one client could rotate through 2^64 buckets. IPv4, mapped or not, stays whole.
 */
function bucket(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const head = ip.replace(/%.*$/, "").split("::")[0];
  const hextets = head ? head.split(":").map((x) => parseInt(x, 16).toString(16)) : [];
  while (hextets.length < 4) hextets.push("0");
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * Client IP for rate limiting. On Vercel the platform rewrites X-Forwarded-For to the real
 * client, so the first entry is trusted. Elsewhere TRUSTED_PROXY_HOPS (default 1) says how many
 * proxies appended to the chain; we take the entry the outermost trusted proxy saw, so clients
 * cannot spoof their way past the limiter.
 */
export function ipFromHeaders(h: Headers): string {
  const xff = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length) {
    const raw = Number(process.env.TRUSTED_PROXY_HOPS ?? (process.env.VERCEL ? 0 : 1));
    const hops = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 1;
    if (hops === 0) return bucket(xff[0]);
    // Chain shorter than the trusted depth means the header was client-supplied: share one bucket.
    if (xff.length < hops) return "untrusted";
    return bucket(xff[xff.length - hops]);
  }
  return bucket(h.get("x-real-ip") ?? h.get("cf-connecting-ip") ?? "0.0.0.0");
}

/**
 * Text or JSON for errors. JSON in → JSON out. Otherwise terminal clients (curl, wget, httpie,
 * xh) get plain text unless they explicitly ask for JSON; browsers and SDKs get JSON. `?plain`
 * forces text.
 */
export function prefersText(req: Request): boolean {
  const url = new URL(req.url);
  if (url.searchParams.has("plain")) return true;
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/json")) return false;
  if (accept.includes("text/plain")) return true;
  if ((req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return false;
  const ua = (req.headers.get("user-agent") ?? "").toLowerCase();
  return /^(curl|wget|httpie|xh)\b/.test(ua);
}

export function bearerToken(req: Request): string | undefined {
  const auth = req.headers.get("authorization") ?? "";
  const [scheme, token] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() === "bearer" && token) return token.trim();
  return undefined;
}

/**
 * Read the body with a hard byte cap. A Content-Length over the cap is refused before a byte is
 * read; without one (chunked uploads) the stream is cut the moment it passes the cap, so an
 * oversized upload never sits in memory.
 */
export async function readCapped(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new HttpError(413, "too_large", `That photo is too big. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      // Cancelling tears the socket down under the client; tell it not to reuse the connection.
      throw new HttpError(413, "too_large", `That photo is too big. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`, { Connection: "close" });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
