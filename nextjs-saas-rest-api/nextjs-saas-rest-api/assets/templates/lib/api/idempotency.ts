// src/lib/api/idempotency.ts
// Idempotency-Key for retry-sensitive POSTs (charging, sending, provisioning, calling a third party). The store is
// an interface so the project backs it with whatever it already has (database table with a unique constraint on
// (scope, key), Redis SET NX...). What matters is that `claim` is atomic.
//
// Behaviour: same key + same payload -> the first response is replayed (header `Idempotent-Replayed: true`);
// same key + different payload -> 422; same key while the first call is still running -> 409.
// Only successful (2xx) responses are stored. If `run` throws, the claim is released so the client can retry.
import { createHash } from 'node:crypto';
import { apiConfig } from '@/config/api';
import { ApiError } from './errors';

export type StoredResponse = { status: number; body: unknown; headers?: Record<string, string> };

export type ClaimResult =
  | { state: 'claimed' }
  | { state: 'in_progress' }
  | { state: 'mismatch' }
  | { state: 'completed'; response: StoredResponse };

export interface IdempotencyStore {
  // Atomically reserve (scope, key). `requestHash` identifies the payload the key was first used with.
  claim(scope: string, key: string, requestHash: string): Promise<ClaimResult>;
  complete(scope: string, key: string, response: StoredResponse): Promise<void>;
  release(scope: string, key: string): Promise<void>;
}

// JSON with sorted keys, so the same payload hashes the same whatever the key order.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const KEY = apiConfig.idempotency.keyPattern;

export async function withIdempotency(
  req: Request,
  options: {
    store: IdempotencyStore;
    // Who and what the key belongs to: `${tenantId}:${userId}:POST /api/v1/refunds`. Keys never cross scopes.
    scope: string;
    // The parsed request body (already validated); it is hashed to detect key reuse with another payload.
    payload: unknown;
    required?: boolean;
  },
  run: () => Promise<StoredResponse>,
): Promise<Response> {
  const key = req.headers.get('idempotency-key');
  if (!key) {
    if (options.required) throw new ApiError('BAD_REQUEST', 'The Idempotency-Key header is required for this operation.');
    return toResponse(await run());
  }
  if (!KEY.test(key)) {
    throw new ApiError('BAD_REQUEST', 'Idempotency-Key must be 8-255 characters: letters, digits and . _ : -');
  }

  const requestHash = createHash('sha256').update(canonicalJson(options.payload)).digest('hex');
  const claim = await options.store.claim(options.scope, key, requestHash);
  switch (claim.state) {
    case 'mismatch':
      throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
    case 'in_progress':
      throw new ApiError('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed.', {
        headers: { 'Retry-After': '2' },
      });
    case 'completed':
      return toResponse(claim.response, { 'Idempotent-Replayed': 'true' });
    case 'claimed':
      break;
  }

  try {
    const response = await run();
    if (response.status >= 200 && response.status < 300) await options.store.complete(options.scope, key, response);
    else await options.store.release(options.scope, key);
    return toResponse(response);
  } catch (err) {
    await options.store.release(options.scope, key);
    throw err;
  }
}

function toResponse(stored: StoredResponse, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ ...stored.headers, ...extra });
  return stored.status === 204 ? new Response(null, { status: 204, headers }) : Response.json(stored.body, { status: stored.status, headers });
}

// Process-memory store for tests and local development ONLY (not shared between instances, lost on restart).
// Entries expire after apiConfig.idempotency.ttlHours, like a production store's cleanup job would do.
export function createMemoryIdempotencyStore(now: () => number = Date.now): IdempotencyStore {
  const ttlMs = apiConfig.idempotency.ttlHours * 3_600_000;
  const entries = new Map<string, { hash: string; createdAt: number; response?: StoredResponse }>();
  const id = (scope: string, key: string) => `${scope}\u0000${key}`;
  return {
    async claim(scope, key, requestHash) {
      let existing = entries.get(id(scope, key));
      if (existing && now() - existing.createdAt > ttlMs) {
        entries.delete(id(scope, key));
        existing = undefined;
      }
      if (!existing) {
        entries.set(id(scope, key), { hash: requestHash, createdAt: now() });
        return { state: 'claimed' };
      }
      if (existing.hash !== requestHash) return { state: 'mismatch' };
      return existing.response ? { state: 'completed', response: existing.response } : { state: 'in_progress' };
    },
    async complete(scope, key, response) {
      const existing = entries.get(id(scope, key));
      if (existing) existing.response = response;
    },
    async release(scope, key) {
      entries.delete(id(scope, key));
    },
  };
}
