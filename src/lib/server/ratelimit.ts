/**
 * Per-IP rate limit for the API. Upstash sliding window when Redis is configured (the Vercel
 * Marketplace names work too), else a fixed window in process memory, which is enough for one
 * self-hosted instance and for tests. Server only.
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { API } from "@/lib/config";
import { HttpError } from "./http";

type Limiter = { limit(id: string): Promise<{ success: boolean; reset: number; remaining: number; limit: number }> };

const WINDOW_MS = 60_000;

/** Requests per minute per IP: `RATE_LIMIT_PER_MIN`, else the default in config. */
export function perMinute(): number {
  const raw = Number(process.env.RATE_LIMIT_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : API.ratePerMinute;
}

export function rateLimitDisabled(): boolean {
  return process.env.DISABLE_RATE_LIMIT === "1";
}

/** Counters live for their window and no longer: a sweep every minute drops the expired ones, so an idle IP is not kept. */
class MemoryLimiter implements Limiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(private max: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, WINDOW_MS).unref();
  }
  async limit(id: string) {
    const now = Date.now();
    let h = this.hits.get(id);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + WINDOW_MS };
      this.hits.set(id, h);
    }
    h.count += 1;
    return { success: h.count <= this.max, reset: h.reset, remaining: Math.max(0, this.max - h.count), limit: this.max };
  }
}

let limiter: Limiter | undefined;

function getLimiter(): Limiter {
  if (limiter) return limiter;
  const max = perMinute();
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    const redis = new Redis({ url, token, enableTelemetry: false });
    limiter = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(max, "1 m"), prefix: "rmbg:rl", analytics: false });
  } else {
    limiter = new MemoryLimiter(max);
  }
  return limiter;
}

/** Throws a 429 HttpError with Retry-After when the caller is over the limit. */
export async function enforceRateLimit(identifier: string): Promise<void> {
  if (rateLimitDisabled()) return;
  const res = await getLimiter().limit(identifier);
  if (!res.success) {
    const retry = Math.max(1, Math.ceil((res.reset - Date.now()) / 1000));
    throw new HttpError(429, "rate_limited", `Too many requests. Try again in ${retry} s.`, {
      "Retry-After": String(retry),
      "X-RateLimit-Limit": String(res.limit),
      "X-RateLimit-Remaining": String(res.remaining),
    });
  }
}
