// src/lib/api/rate-limit.ts
// Rate limiting behind a small interface, so the store (Redis, KV, a database table...) is the project's choice.
// Headers follow the IETF RateLimit header fields draft (draft-ietf-httpapi-ratelimit-headers):
//   RateLimit-Policy: "default";q=100;w=60      quota and window
//   RateLimit: "default";r=40;t=12              remaining units and seconds until reset
// plus Retry-After on 429. Older drafts used RateLimit-Limit/-Remaining/-Reset; don't emit those.
import { ApiError } from './errors';

export type RateLimitPolicy = { name: string; quota: number; windowSeconds: number };
export type RateLimitResult = { allowed: boolean; remaining: number; resetSeconds: number };

export interface RateLimiter {
  // Counts one request for `key` (tenant, user or IP) under `policy`. Must be atomic and shared across instances.
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
}

export function rateLimitHeaders(policy: RateLimitPolicy, result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Policy': `"${policy.name}";q=${policy.quota};w=${policy.windowSeconds}`,
    RateLimit: `"${policy.name}";r=${Math.max(0, result.remaining)};t=${result.resetSeconds}`,
  };
}

// Call right after authentication (or before it, keyed by IP, for sign-in and other anonymous endpoints).
// Returns the headers to attach to the success response; throws a 429 ApiError (with the same headers) otherwise.
export async function enforceRateLimit(
  limiter: RateLimiter,
  policy: RateLimitPolicy,
  key: string,
): Promise<Record<string, string>> {
  const result = await limiter.consume(`${policy.name}:${key}`, policy);
  const headers = rateLimitHeaders(policy, result);
  if (!result.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many requests. Retry later.', {
      headers: { ...headers, 'Retry-After': String(Math.max(1, result.resetSeconds)) },
    });
  }
  return headers;
}

// Fixed-window limiter held in process memory. For tests and local development ONLY: on serverless or with several
// instances each process counts separately, so the limit is not enforced.
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(key, policy) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + policy.windowSeconds * 1000 };
        windows.set(key, w);
      }
      w.count += 1;
      return {
        allowed: w.count <= policy.quota,
        remaining: policy.quota - w.count,
        resetSeconds: Math.ceil((w.resetAt - t) / 1000),
      };
    },
  };
}
