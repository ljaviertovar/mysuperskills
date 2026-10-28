// src/config/api.ts
// The single place for every API limit and setting: pagination, body size, rate limits, timeouts, idempotency,
// allowed origins and response headers. Handlers and helpers read `apiConfig`; no magic numbers elsewhere.
//
// Each value has a safe default and can be overridden with an environment variable. Variables are validated with
// Zod when this module is first imported: an invalid value stops the app at startup with a readable message,
// instead of surfacing later as odd behavior. Server-only: never import this from client components, and never
// put these variables under NEXT_PUBLIC_.
import { z } from 'zod';

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const list = z.string().transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const envSchema = z
  .object({
    // Pagination: page size used when the client sends no `limit`, and the hard cap it may ask for.
    API_PAGE_SIZE_DEFAULT: int(1, 500).default(20),
    API_PAGE_SIZE_MAX: int(1, 500).default(100),

    // Largest JSON body accepted, in bytes (Route Handlers have no built-in limit). 100 KiB fits typical payloads.
    API_MAX_BODY_BYTES: int(1_024, 10 * 1_024 * 1_024).default(100 * 1_024),

    // Rate limits. `default` applies to authenticated traffic per tenant; `sensitive` to sign-in, password reset,
    // exports and other abuse-prone or expensive endpoints (usually keyed by IP or user).
    API_RATE_LIMIT_QUOTA: int(1, 1_000_000).default(120),
    API_RATE_LIMIT_WINDOW_SECONDS: int(1, 86_400).default(60),
    API_RATE_LIMIT_SENSITIVE_QUOTA: int(1, 1_000_000).default(10),
    API_RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: int(1, 86_400).default(60),

    // Timeouts. The handler deadline must stay below each route's `maxDuration` (seconds) so the API answers a
    // controlled 503 before the platform kills the function. Outbound calls get a shorter budget per attempt.
    API_HANDLER_TIMEOUT_MS: int(100, 900_000).default(25_000),
    API_OUTBOUND_TIMEOUT_MS: int(100, 120_000).default(5_000),
    API_OUTBOUND_MAX_RETRIES: int(0, 3).default(2),

    // How long an Idempotency-Key is remembered. 24-72 h covers client retry windows.
    API_IDEMPOTENCY_TTL_HOURS: int(1, 720).default(48),

    // Browser origins allowed to call the API cross-origin with credentials (CORS) and to send state-changing
    // requests with a session cookie (CSRF). Comma-separated, exact origins: https://app.example.com
    API_ALLOWED_ORIGINS: list.default([]),

    // Strict-Transport-Security max-age in seconds (2 years). Set 0 only for local development over http.
    API_HSTS_MAX_AGE_SECONDS: int(0, 63_072_000).default(63_072_000),
  })
  .refine((env) => env.API_PAGE_SIZE_DEFAULT <= env.API_PAGE_SIZE_MAX, {
    message: 'API_PAGE_SIZE_DEFAULT must not exceed API_PAGE_SIZE_MAX',
    path: ['API_PAGE_SIZE_DEFAULT'],
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid API configuration:\n${z.prettifyError(parsed.error)}`);
}
const env = parsed.data;

export const apiConfig = {
  pagination: { defaultSize: env.API_PAGE_SIZE_DEFAULT, maxSize: env.API_PAGE_SIZE_MAX },
  body: { maxBytes: env.API_MAX_BODY_BYTES },
  rateLimit: {
    default: { name: 'default', quota: env.API_RATE_LIMIT_QUOTA, windowSeconds: env.API_RATE_LIMIT_WINDOW_SECONDS },
    sensitive: { name: 'sensitive', quota: env.API_RATE_LIMIT_SENSITIVE_QUOTA, windowSeconds: env.API_RATE_LIMIT_SENSITIVE_WINDOW_SECONDS },
  },
  timeouts: {
    handlerMs: env.API_HANDLER_TIMEOUT_MS,
    outboundMs: env.API_OUTBOUND_TIMEOUT_MS,
    outboundMaxRetries: env.API_OUTBOUND_MAX_RETRIES,
    retryAfterSeconds: 5, // Retry-After sent with 503 responses
  },
  idempotency: { ttlHours: env.API_IDEMPOTENCY_TTL_HOURS, keyPattern: /^[A-Za-z0-9._:-]{8,255}$/ },
  origins: { allowed: env.API_ALLOWED_ORIGINS },
  headers: {
    // Default for authenticated JSON: nothing may store it. Routes serving non-sensitive data clients revalidate
    // with If-None-Match can override it with 'private, no-cache'.
    cacheControl: 'private, no-store',
    security: {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...(env.API_HSTS_MAX_AGE_SECONDS > 0
        ? { 'Strict-Transport-Security': `max-age=${env.API_HSTS_MAX_AGE_SECONDS}; includeSubDomains` }
        : {}),
    } as Record<string, string>,
  },
} as const;

export type ApiConfig = typeof apiConfig;
