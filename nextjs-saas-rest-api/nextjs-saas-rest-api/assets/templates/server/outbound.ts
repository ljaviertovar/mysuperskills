// src/server/outbound.ts
// Outbound HTTP with an explicit timeout and bounded retries. Retries only happen for transient failures
// (network error, timeout, 429, 502-504) AND only when the request is idempotent or carries an Idempotency-Key.
// Every failed attempt is logged (`api.dependency_attempt_failed`), so dependency failure rates can be charted
// from the logs. Exhausted retries become DomainError('unavailable') -> controlled 503.
// Budgets come from src/config/api.ts.
import { apiConfig } from '@/config/api';
import { logger } from '@/lib/api/logger';
import { DomainError } from './domain-errors';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

export async function fetchWithTimeout(
  dependency: string, // name used in logs, e.g. 'payments', 'email'
  url: string | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? apiConfig.timeouts.outboundMs;
  const method = (init.method ?? 'GET').toUpperCase();
  const hasIdempotencyKey = new Headers(init.headers).has('idempotency-key');
  const canRetry = IDEMPOTENT_METHODS.has(method) || hasIdempotencyKey;
  const maxAttempts = canRetry ? 1 + Math.min(options.retries ?? apiConfig.timeouts.outboundMaxRetries, 3) : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = performance.now();
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!TRANSIENT_STATUS.has(response.status)) return response;
      lastError = new Error(`${dependency} responded ${response.status}`);
      logger.warn('api.dependency_attempt_failed', {
        dependency, attempt, status: response.status, duration_ms: Math.round(performance.now() - startedAt),
      });
      if (attempt === maxAttempts) return response; // caller decides; still counted as a failure above
    } catch (err) {
      lastError = err; // TimeoutError / network failure
      logger.warn('api.dependency_attempt_failed', {
        dependency, attempt, error: err instanceof Error ? err.name : 'unknown', duration_ms: Math.round(performance.now() - startedAt),
      });
    }
    if (attempt < maxAttempts) {
      const backoff = 200 * 2 ** (attempt - 1) + Math.random() * 100; // exponential backoff with jitter
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw new DomainError('unavailable', 'A required service is temporarily unavailable. Retry later.', 'SERVICE_UNAVAILABLE', undefined, dependency, {
    cause: lastError,
  });
}
// Always validate the external response body with Zod before using it: it is untrusted input too.
