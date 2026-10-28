// src/lib/api/deprecation.test.ts (Vitest)
import { describe, expect, it } from 'vitest';
import { replaceVersion, withDeprecation } from '@/lib/api/deprecation';
import { withApi } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const INFO = {
  deprecatedAt: new Date('2026-11-09T00:00:00Z'),
  sunsetAt: new Date('2027-05-10T00:00:00Z'),
  successor: replaceVersion('v1', 'v2'),
  docs: 'https://docs.example.com/migrate-v2',
};

const ok = withDeprecation(INFO, withApi('/api/v1/invoices/[id]', async () => Response.json({ data: {} })));
const failing = withDeprecation(
  INFO,
  withApi('/api/v1/invoices/[id]', async () => {
    throw new ApiError('NOT_FOUND', 'Invoice not found.');
  }),
);
const ctx = { params: Promise.resolve({}) };

describe('withDeprecation', () => {
  it('points each route at its own v2 equivalent, keeping the id and the query string', async () => {
    const list = await ok(new Request('http://localhost/api/v1/invoices?status=open'), ctx);
    expect(list.headers.get('link')).toContain('</api/v2/invoices?status=open>; rel="successor-version"');
    const one = await ok(new Request('http://localhost/api/v1/invoices/inv_42'), ctx);
    expect(one.headers.get('link')).toContain('</api/v2/invoices/inv_42>; rel="successor-version"');
  });

  it('adds Deprecation and Sunset, also on error responses', async () => {
    const res = await failing(new Request('http://localhost/api/v1/invoices/missing'), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('deprecation')).toBe(`@${Math.floor(INFO.deprecatedAt.getTime() / 1000)}`);
    expect(res.headers.get('sunset')).toBe('Mon, 10 May 2027 00:00:00 GMT');
    expect(res.headers.get('link')).toContain('</api/v2/invoices/missing>; rel="successor-version"');
  });
});
