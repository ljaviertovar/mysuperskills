// src/lib/api/idempotency.test.ts (Vitest) — behaviour of withIdempotency and the rate limiter helpers.
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { createMemoryIdempotencyStore, withIdempotency } from '@/lib/api/idempotency';
import { createMemoryRateLimiter, enforceRateLimit } from '@/lib/api/rate-limit';

const post = (key: string | null) =>
  new Request('http://localhost/api/v1/refunds', { method: 'POST', headers: key ? { 'idempotency-key': key } : {} });

function setup() {
  const store = createMemoryIdempotencyStore();
  let executions = 0;
  const call = (key: string | null, payload: unknown, run?: () => Promise<{ status: number; body: unknown }>) =>
    withIdempotency(post(key), { store, scope: 't1:u1:POST /api/v1/refunds', payload }, run ?? (async () => {
      executions += 1;
      return { status: 201, body: { data: { id: 'rf_1' } }, headers: { Location: '/api/v1/refunds/rf_1' } };
    }));
  return { call, executions: () => executions };
}

describe('withIdempotency', () => {
  it('runs once and replays the stored response, headers included, for the same key and payload', async () => {
    const { call, executions } = setup();
    const first = await call('key-12345678', { amount: 100, reason: 'dup' });
    const second = await call('key-12345678', { reason: 'dup', amount: 100 }); // key order must not matter
    expect(executions()).toBe(1);
    expect(second.status).toBe(201);
    expect(second.headers.get('location')).toBe('/api/v1/refunds/rf_1');
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
  });

  it('422 when the key is reused with a different payload', async () => {
    const { call } = setup();
    await call('key-12345678', { amount: 100 });
    await expect(call('key-12345678', { amount: 999 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
  });

  it('409 while the first request is still running', async () => {
    const { call } = setup();
    let release!: () => void;
    const slow = call('key-12345678', { a: 1 }, () => new Promise((resolve) => { release = () => resolve({ status: 201, body: {} }); }));
    await new Promise((r) => setTimeout(r, 0));
    await expect(call('key-12345678', { a: 1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });
    release();
    await slow;
  });

  it('releases the key when the work throws, so the client can retry', async () => {
    const { call, executions } = setup();
    await expect(call('key-12345678', { a: 1 }, async () => { throw new ApiError('SERVICE_UNAVAILABLE', 'down'); })).rejects.toBeInstanceOf(ApiError);
    const retry = await call('key-12345678', { a: 1 });
    expect(retry.status).toBe(201);
    expect(executions()).toBe(1);
  });

  it('400 for malformed keys; runs without a key unless required', async () => {
    const { call } = setup();
    await expect(call('short', {})).rejects.toMatchObject({ status: 400 });
    expect((await call(null, {})).status).toBe(201);
  });
});

describe('enforceRateLimit', () => {
  const policy = { name: 'default', quota: 2, windowSeconds: 60 };

  it('advertises the policy, then answers 429 with Retry-After once the quota is spent', async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const first = await enforceRateLimit(limiter, policy, 'tenant-1');
    expect(first['RateLimit-Policy']).toBe('"default";q=2;w=60');
    expect(first.RateLimit).toBe('"default";r=1;t=60');
    await enforceRateLimit(limiter, policy, 'tenant-1');
    await expect(enforceRateLimit(limiter, policy, 'tenant-1')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('counts each key separately', async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    await enforceRateLimit(limiter, policy, 'a');
    await enforceRateLimit(limiter, policy, 'a');
    await expect(enforceRateLimit(limiter, policy, 'b')).resolves.toBeTruthy();
  });
});
