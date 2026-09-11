/** GET /api/v1/info: what this instance takes and how much of it. */
import pkg from "../../../../../package.json";
import { API, LIMITS, SITE } from "@/lib/config";
import { json, options } from "@/lib/server/http";
import { perMinute, rateLimitDisabled } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

export function GET() {
  return json(
    {
      name: SITE.name,
      version: pkg.version,
      engine: API.engine,
      model: API.model,
      limits: { maxBytes: LIMITS.apiMaxBytes, maxEdge: LIMITS.maxEdge, maxPixels: LIMITS.apiMaxPixels },
      backdrops: API.backdrops,
      formats: API.formats,
      rateLimit: { perMinute: rateLimitDisabled() ? null : perMinute() },
      auth: process.env.API_KEY ? "bearer" : "none",
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
