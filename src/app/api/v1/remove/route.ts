/**
 * POST /api/v1/remove: the photo in, the cutout out. Raw bytes or multipart (`image`, or
 * `file`); options in the query string, and as fields for multipart. Nothing is stored: the
 * photo lives in memory for the request and is gone when the response is sent.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { API, LIMITS } from "@/lib/config";
import { resultName } from "@/lib/format";
import { CORS_HEADERS, HttpError, NO_STORE, bearerToken, errorResponse, ipFromHeaders, options, prefersText, readCapped } from "@/lib/server/http";
import { BusyError, InvalidImageError, UnsupportedImageError, parseHex, remove, sniff, type Backdrop, type Format } from "@/lib/server/infer";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Next wants a literal here; API.maxDuration in config quotes the same number.
export const maxDuration = 60;

export const OPTIONS = options;

type Options = { backdrop: Backdrop; format: Format; download: boolean; name: string | null };

const isOff = (v: string) => /^(0|false|no|off)$/i.test(v);

/** Query first, multipart fields as a fallback. */
function parseOptions(query: URLSearchParams, fields?: FormData): Options {
  const get = (k: string): string | null => {
    const q = query.get(k);
    if (q !== null) return q;
    const f = fields?.get(k);
    return typeof f === "string" ? f : null;
  };
  const bgRaw = (get("bg") ?? "transparent").trim().toLowerCase();
  let backdrop: Backdrop;
  if (bgRaw === "" || bgRaw === "transparent") backdrop = { kind: "transparent" };
  else if (bgRaw === "white") backdrop = { kind: "color", r: 255, g: 255, b: 255 };
  else if (bgRaw === "black") backdrop = { kind: "color", r: 0, g: 0, b: 0 };
  else if (bgRaw === "blur") backdrop = { kind: "blur" };
  else {
    const rgb = parseHex(bgRaw);
    if (!rgb) throw new HttpError(400, "invalid", "Unknown bg. Use transparent, white, black, blur, or a hex colour like #1e90ff.");
    backdrop = { kind: "color", ...rgb };
  }
  const fmtRaw = (get("format") ?? "png").trim().toLowerCase();
  if (fmtRaw !== "png" && fmtRaw !== "webp") throw new HttpError(400, "invalid", "Unknown format. Use png or webp.");
  const dl = get("download");
  return { backdrop, format: fmtRaw, download: dl !== null && !isOff(dl), name: get("name") };
}

/** Constant-time check of the bearer token against API_KEY when one is set. */
function checkAuth(req: Request): void {
  const key = process.env.API_KEY;
  if (!key) return;
  const given = bearerToken(req) ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(key).digest();
  if (!given || !timingSafeEqual(a, b)) throw new HttpError(401, "unauthorized", "This instance needs a key. Send it as Authorization: Bearer <key>.");
}

async function handle(req: Request): Promise<Response> {
  await enforceRateLimit(ipFromHeaders(req.headers));
  checkAuth(req);

  const query = new URL(req.url).searchParams;
  let opts = parseOptions(query);
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  const body = await readCapped(req, LIMITS.apiMaxBytes);

  let image = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  let stem: string | null = opts.name;
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": req.headers.get("content-type")! } }).formData();
    } catch {
      throw new HttpError(400, "invalid", "That multipart body didn't parse.");
    }
    const part = form.get("image") ?? form.get("file");
    if (!(part instanceof File)) throw new HttpError(400, "invalid", "Send the photo as a multipart field named image.");
    opts = parseOptions(query, form);
    image = Buffer.from(await part.arrayBuffer());
    stem = opts.name ?? (part.name && part.name !== "blob" ? part.name : null);
  }
  if (image.length === 0) throw new HttpError(400, "invalid", "Send the photo as the request body, or as a multipart field named image.");

  let sniffed;
  try {
    sniffed = await sniff(image);
  } catch (e) {
    if (e instanceof UnsupportedImageError) throw new HttpError(415, "unsupported_type", e.message);
    throw e;
  }
  // Refused here, before a queue slot: a small PNG can declare hundreds of megapixels.
  if (sniffed.width * sniffed.height > LIMITS.apiMaxPixels) {
    throw new HttpError(413, "too_large", `That photo has too many pixels (over ${Math.round(LIMITS.apiMaxPixels / 1e6)} MP). Downscale it first.`);
  }

  let result;
  try {
    result = await remove(image, { backdrop: opts.backdrop, format: opts.format });
  } catch (e) {
    if (e instanceof InvalidImageError) throw new HttpError(400, "invalid", e.message);
    if (e instanceof BusyError) throw new HttpError(503, "busy", "The server is busy. Try again in a few seconds.", { "Retry-After": "5" });
    throw new HttpError(500, "engine", "The model didn't answer. Try again in a moment.", undefined, e);
  }

  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    ...NO_STORE,
    "Content-Type": result.contentType,
    "Content-Length": String(result.bytes.length),
    "X-Engine": API.engine,
    "X-Duration-Ms": String(result.ms),
    "X-Image-Size": `${result.width}x${result.height}`,
  };
  if (opts.download) {
    const ext = opts.format === "webp" ? ".webp" : ".png";
    const name = resultName(stem || "photo").replace(/\.png$/, ext);
    // The plain parameter is a ByteString: anything outside printable ASCII would make the header throw, so it gets the tail only.
    const ascii = name.replace(/[^\x20-\x7e]+/g, "-").replace(/["\\]/g, "-").replace(/^-+|-+$/g, "") || `photo-rmbg${ext}`;
    headers["Content-Disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return new NextResponse(new Uint8Array(result.bytes), { status: 200, headers });
}

export async function POST(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } catch (e) {
    return errorResponse(e, prefersText(req));
  }
}
