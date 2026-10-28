// src/lib/api/handler.test.ts (Vitest) — what withApi adds to every route: CSRF, security headers, deadline.
import { describe, expect, it } from 'vitest';
import { apiConfig } from '@/config/api';
import { withApi } from '@/lib/api/handler';

const ctx = { params: Promise.resolve({}) };
const okRoute = withApi('/api/v1/things', async () => Response.json({ data: { ok: true } }));

const post = (headers: Record<string, string>) =>
  okRoute(new Request('http://api.example.com/api/v1/things', { method: 'POST', headers: { host: 'api.example.com', ...headers } }), ctx);

describe('CSRF protection for cookie sessions', () => {
  it('403 CSRF_REJECTED for a cookie-authenticated POST from a foreign origin', async () => {
    const res = await post({ cookie: 'session=abc', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('CSRF_REJECTED');
  });

  it('blocks cross-site requests that only send Sec-Fetch-Site', async () => {
    expect((await post({ cookie: 'session=abc', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('allows same-origin cookie requests, bearer requests, cookie-less requests and safe methods', async () => {
    expect((await post({ cookie: 'session=abc', origin: 'http://api.example.com' })).status).toBe(200);
    expect((await post({ cookie: 'session=abc', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post({ authorization: 'Bearer t', origin: 'https://evil.example' })).status).toBe(200);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(200);
    const get = await okRoute(new Request('http://api.example.com/api/v1/things', { headers: { cookie: 'session=abc', origin: 'https://evil.example' } }), ctx);
    expect(get.status).toBe(200);
  });
});

describe('response headers', () => {
  it('sets every security header from the config, plus request id and cache policy, also on errors', async () => {
    const failing = withApi('/api/v1/things', async () => {
      throw new Error('boom');
    });
    for (const res of [await okRoute(new Request('http://x/api/v1/things'), ctx), await failing(new Request('http://x/api/v1/things'), ctx)]) {
      for (const [name, value] of Object.entries(apiConfig.headers.security)) expect(res.headers.get(name)).toBe(value);
      expect(res.headers.get('cache-control')).toBe(apiConfig.headers.cacheControl);
      expect(res.headers.get('x-request-id')).toBeTruthy();
    }
  });

  it('keeps headers a route set on purpose', async () => {
    const cacheable = withApi('/api/v1/things', async () => Response.json({ data: 1 }, { headers: { 'Cache-Control': 'private, no-cache' } }));
    expect((await cacheable(new Request('http://x/api/v1/things'), ctx)).headers.get('cache-control')).toBe('private, no-cache');
  });
});

describe('deadline', () => {
  it('answers 503 TIMEOUT with Retry-After when the handler exceeds its budget, and aborts the signal', async () => {
    let aborted = false;
    const slow = withApi(
      '/api/v1/slow',
      async (_req, { api }) => {
        api.signal.addEventListener('abort', () => (aborted = true));
        await new Promise((resolve) => setTimeout(resolve, 200));
        return Response.json({ data: 'late' });
      },
      { timeoutMs: 20 },
    );
    const res = await slow(new Request('http://x/api/v1/slow'), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('TIMEOUT');
    expect(res.headers.get('retry-after')).toBe(String(apiConfig.timeouts.retryAfterSeconds));
    expect(aborted).toBe(true);
  });
});
