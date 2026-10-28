// src/lib/api/handler.ts
// Wrap every Route Handler export with withApi(). For each request it:
//   1. assigns a request id (a sane incoming x-request-id, or a new UUID) and reads the W3C trace id if present;
//   2. blocks cross-site state-changing requests that ride on a session cookie (CSRF);
//   3. runs the handler under a deadline (apiConfig.timeouts.handlerMs) and answers a controlled 503 when exceeded;
//   4. converts thrown errors into the standard error shape;
//   5. sets the security and cache headers from src/config/api.ts;
//   6. writes one structured access log after the response is sent (next/server `after`).
import { after } from 'next/server';
import { apiConfig } from '@/config/api';
import { ApiError, toErrorResponse } from './errors';
import { logger } from './logger';

export type ApiContext = {
  requestId: string;
  // Aborted when the deadline passes: pass it to fetchWithTimeout / data-layer calls that accept a signal.
  signal: AbortSignal;
};

// Next's generated RouteContext<'/api/v1/...'> satisfies this shape.
type RouteCtx = { params: Promise<unknown> };

const INCOMING_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// `after` only works inside a Next.js request scope; outside it (unit tests calling handlers directly) run inline.
function runAfterResponse(task: () => void): void {
  try {
    after(task);
  } catch {
    task();
  }
}

// CSRF: a browser attaches cookies to cross-site requests automatically, so a cookie-authenticated mutation must
// prove it comes from our own origin (or an allowlisted one). Requests with an Authorization header carry an
// explicit credential, and requests without cookies carry none, so neither can be forged this way.
export function isCrossSiteCookieRequest(req: Request): boolean {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  if (req.headers.has('authorization') || !req.headers.has('cookie')) return false;

  const origin = req.headers.get('origin');
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return true; // malformed Origin, including the literal "null"
    }
    const ownHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
    return host !== ownHost && !apiConfig.origins.allowed.includes(origin);
  }
  // No Origin: modern browsers still send Sec-Fetch-Site. Non-browser clients send neither and are not CSRF.
  const site = req.headers.get('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
}

export function withApi<Ctx extends RouteCtx = { params: Promise<Record<string, never>> }>(
  // Route template, not the concrete URL, so logs stay low-cardinality: '/api/v1/meal-plans/[id]'
  route: string,
  handler: (req: Request, ctx: Ctx & { api: ApiContext }) => Promise<Response>,
  options: { timeoutMs?: number } = {},
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const incoming = req.headers.get('x-request-id');
    const requestId = incoming && INCOMING_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    const traceId = TRACEPARENT.exec(req.headers.get('traceparent') ?? '')?.[1];
    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? apiConfig.timeouts.handlerMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);

    let response: Response;
    try {
      if (isCrossSiteCookieRequest(req)) {
        throw new ApiError('CSRF_REJECTED', 'Cross-site requests with a session cookie are not allowed.');
      }
      const timedOut = new Promise<never>((_, reject) =>
        deadline.signal.addEventListener('abort', () =>
          reject(new ApiError('TIMEOUT', 'The request took too long to complete. Retry later.', {
            headers: { 'Retry-After': String(apiConfig.timeouts.retryAfterSeconds) },
          })),
        ),
      );
      response = await Promise.race([handler(req, { ...ctx, api: { requestId, signal: deadline.signal } }), timedOut]);
    } catch (err) {
      response = toErrorResponse(err, requestId, { route, method: req.method });
    } finally {
      clearTimeout(timer);
    }

    response.headers.set('x-request-id', requestId);
    for (const [name, value] of Object.entries(apiConfig.headers.security)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
    // Authenticated responses must not be stored by browsers, CDNs or shared caches unless the route opts in.
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', apiConfig.headers.cacheControl);

    // One line per request. These fields are the metrics source: request rate, 5xx rate and latency percentiles
    // per route and method (see references/patterns.md, "Metrics from structured logs").
    const status = response.status;
    const durationMs = Math.round(performance.now() - startedAt);
    runAfterResponse(() =>
      logger.info('api.request', {
        route, method: req.method, status, duration_ms: durationMs, request_id: requestId,
        ...(traceId ? { trace_id: traceId } : {}),
      }),
    );
    return response;
  };
}
