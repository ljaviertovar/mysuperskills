// src/app/api/v1/meal-plans/route.test.ts  (Vitest)
// Contract tests that run the real handlers, service and Zod schemas against the in-memory repository, so status
// codes, envelopes, pagination, tenant isolation and optimistic concurrency are all exercised without a database.
// Only the authentication (principal) and the data layer (repository) are replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/api/principal', () => ({ resolvePrincipal: vi.fn() }));
vi.mock('@/server/meal-plans/repository', async (importOriginal) => {
  const { createMemoryMealPlanRepository } = await import('@/server/meal-plans/repository.memory');
  return {
    ...(await importOriginal<typeof import('@/server/meal-plans/repository')>()),
    createMealPlanRepository: createMemoryMealPlanRepository,
  };
});

import { DELETE as deleteOne, GET as getOne, PATCH as patchOne } from '@/app/api/v1/meal-plans/[id]/route';
import { GET as list, POST as create } from '@/app/api/v1/meal-plans/route';
import { resolvePrincipal } from '@/lib/api/principal';
import { DomainError } from '@/server/domain-errors';
import { memoryStore } from '@/server/meal-plans/repository.memory';
import { mealPlanDtoSchema } from './contract';

const errorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    message: z.string().min(1),
    details: z.array(z.object({ path: z.string().optional(), code: z.string(), message: z.string() })).optional(),
    request_id: z.string().min(1),
  }),
});
const singleSchema = z.strictObject({ data: mealPlanDtoSchema });
const collectionSchema = z.strictObject({
  data: z.array(mealPlanDtoSchema),
  meta: z.object({ limit: z.number(), has_more: z.boolean(), next_cursor: z.string().nullable() }),
  links: z.object({ self: z.string(), next: z.string().nullable() }),
});

const noParams = { params: Promise.resolve({}) as Promise<Record<string, never>> };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

function request(path: string, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return new Request(`http://localhost${path}`, { ...init, headers, body });
}

const asUser = (tenantId: string, role = 'member') =>
  vi.mocked(resolvePrincipal).mockResolvedValue({ userId: `user-${tenantId}`, tenantId, role });

async function createPlan(name: string) {
  const res = await create(request('/api/v1/meal-plans', { method: 'POST', json: { name, starts_on: '2026-11-02' } }), noParams);
  expect(res.status).toBe(201);
  return { res, dto: singleSchema.parse(await res.json()).data };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorSchema.parse(await res.json());
  expect(body.error.code).toBe(code);
  expect(body.error.request_id).toBe(res.headers.get('x-request-id'));
  return body;
}

beforeEach(() => {
  vi.resetAllMocks();
  memoryStore.reset();
  asUser('tenant-a');
});

describe('authentication and authorization', () => {
  it('401 with the standard error shape when there is no valid credential', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValue(null);
    await expectError(await list(request('/api/v1/meal-plans'), noParams), 401, 'UNAUTHENTICATED');
  });

  it('403 when the role may not delete, 204 when it may', async () => {
    const { dto } = await createPlan('Week 1');
    await expectError(await deleteOne(request(`/api/v1/meal-plans/${dto.id}`, { method: 'DELETE' }), idParams(dto.id)), 403, 'FORBIDDEN');
    asUser('tenant-a', 'owner');
    expect((await deleteOne(request(`/api/v1/meal-plans/${dto.id}`, { method: 'DELETE' }), idParams(dto.id))).status).toBe(204);
    await expectError(await getOne(request(`/api/v1/meal-plans/${dto.id}`), idParams(dto.id)), 404, 'NOT_FOUND');
  });

  it("another tenant gets 404 for a plan it does not own, and never sees it in lists", async () => {
    const { dto } = await createPlan('Tenant A plan');
    asUser('tenant-b');
    await expectError(await getOne(request(`/api/v1/meal-plans/${dto.id}`), idParams(dto.id)), 404, 'NOT_FOUND');
    const res = await list(request('/api/v1/meal-plans'), noParams);
    expect(collectionSchema.parse(await res.json()).data).toHaveLength(0);
  });
});

describe('create', () => {
  it('201 with Location, ETag, request id and no-store, and the body matches the DTO schema', async () => {
    const { res, dto } = await createPlan('Week 1');
    expect(res.headers.get('location')).toBe(`/api/v1/meal-plans/${dto.id}`);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(dto.status).toBe('draft');
  });

  it('415 for non-JSON bodies', async () => {
    const res = await create(request('/api/v1/meal-plans', { method: 'POST', body: 'name=x', headers: { 'content-type': 'text/plain' } }), noParams);
    await expectError(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('422 for unknown write fields (no mass assignment) without touching storage', async () => {
    const res = await create(
      request('/api/v1/meal-plans', { method: 'POST', json: { name: 'x', starts_on: '2026-11-02', tenant_id: 'tenant-b', status: 'active' } }),
      noParams,
    );
    const body = await expectError(res, 422, 'VALIDATION_FAILED');
    expect(body.error.details?.length).toBeGreaterThan(0);
    expect(memoryStore.rows).toHaveLength(0);
  });

  it('stamps the tenant from the principal even if the client tries to choose one', async () => {
    await createPlan('Week 1');
    expect(memoryStore.rows[0].tenant_id).toBe('tenant-a');
  });
});

describe('list and pagination', () => {
  it('pages with an opaque cursor: no duplicates, no gaps, next is null on the last page', async () => {
    for (const n of ['one', 'two', 'three']) await createPlan(n);
    const first = collectionSchema.parse(await (await list(request('/api/v1/meal-plans?limit=2'), noParams)).json());
    expect(first.data).toHaveLength(2);
    expect(first.meta.has_more).toBe(true);
    expect(first.links.next).toMatch(/^\/api\/v1\/meal-plans\?limit=2&cursor=/);

    const second = collectionSchema.parse(await (await list(request(first.links.next!), noParams)).json());
    expect(second.data).toHaveLength(1);
    expect(second.links.next).toBeNull();
    const ids = [...first.data, ...second.data].map((d) => d.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('400 for a limit above the cap, unknown filters, and a cursor that is forged or for another sort', async () => {
    await expectError(await list(request('/api/v1/meal-plans?limit=1000'), noParams), 400, 'INVALID_PARAMETERS');
    await expectError(await list(request('/api/v1/meal-plans?tenant_id=tenant-b'), noParams), 400, 'INVALID_PARAMETERS');
    const forged = Buffer.from(JSON.stringify({ sort: '-created_at', created_at: 'x"),or(tenant_id.neq.a', id: 'x' })).toString('base64url');
    await expectError(await list(request(`/api/v1/meal-plans?cursor=${forged}`), noParams), 400, 'INVALID_PARAMETERS');
    await createPlan('one');
    await createPlan('two');
    const page = collectionSchema.parse(await (await list(request('/api/v1/meal-plans?limit=1'), noParams)).json());
    const cursor = new URL(`http://x${page.links.next}`).searchParams.get('cursor');
    await expectError(await list(request(`/api/v1/meal-plans?sort=created_at&cursor=${cursor}`), noParams), 400, 'INVALID_PARAMETERS');
  });
});

describe('update with optimistic concurrency', () => {
  it('428 without If-Match, 412 when stale, 200 with a new ETag, and omitted fields are left alone', async () => {
    const { dto } = await createPlan('Week 1');
    const url = `/api/v1/meal-plans/${dto.id}`;
    await expectError(await patchOne(request(url, { method: 'PATCH', json: { notes: 'x' } }), idParams(dto.id)), 428, 'PRECONDITION_REQUIRED');

    const ok = await patchOne(request(url, { method: 'PATCH', json: { notes: 'vegan' }, headers: { 'if-match': '"1"' } }), idParams(dto.id));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toBe('"2"');
    const updated = singleSchema.parse(await ok.json()).data;
    expect(updated.notes).toBe('vegan');
    expect(updated.name).toBe('Week 1');
    expect(updated.status).toBe('draft');

    const stale = await patchOne(request(url, { method: 'PATCH', json: { notes: 'again' }, headers: { 'if-match': '"1"' } }), idParams(dto.id));
    await expectError(stale, 412, 'PRECONDITION_FAILED');
  });

  it('GET answers 304 with no body when If-None-Match holds the current ETag, 200 after a change', async () => {
    const { dto } = await createPlan('Week 1');
    const url = `/api/v1/meal-plans/${dto.id}`;
    const cached = await getOne(request(url, { headers: { 'if-none-match': 'W/"1"' } }), idParams(dto.id));
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(cached.headers.get('etag')).toBe('"1"');

    await patchOne(request(url, { method: 'PATCH', json: { notes: 'changed' }, headers: { 'if-match': '"1"' } }), idParams(dto.id));
    const fresh = await getOne(request(url, { headers: { 'if-none-match': '"1"' } }), idParams(dto.id));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).toBe('"2"');
  });

  it('422 for an empty PATCH body', async () => {
    const { dto } = await createPlan('Week 1');
    const res = await patchOne(request(`/api/v1/meal-plans/${dto.id}`, { method: 'PATCH', json: {}, headers: { 'if-match': '"1"' } }), idParams(dto.id));
    await expectError(res, 422, 'VALIDATION_FAILED');
  });
});

describe('failures never leak internals', () => {
  it('503 with Retry-After when the data layer is unavailable', async () => {
    memoryStore.failNext = new DomainError('unavailable', 'The service is temporarily unavailable. Retry later.', 'SERVICE_UNAVAILABLE', undefined, 'database');
    const res = await list(request('/api/v1/meal-plans'), noParams);
    await expectError(res, 503, 'SERVICE_UNAVAILABLE');
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('500 with a generic message for unexpected errors', async () => {
    memoryStore.failNext = new Error('SELECT * FROM secrets: password authentication failed');
    const res = await list(request('/api/v1/meal-plans'), noParams);
    const body = await expectError(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toMatch(/SELECT|password|secrets|stack/i);
  });
});
