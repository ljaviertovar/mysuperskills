// src/app/api/v1/meal-plans/route.ts
// Thin HTTP adapter: auth -> parse -> service -> DTO -> envelope. No business logic here.
import { requireAuth } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { etagFor } from '@/lib/api/etag';
import { withApi } from '@/lib/api/handler';
import { decodeCursor, encodeCursor, pageLinks, splitPage } from '@/lib/api/pagination';
import { assertAcceptsJson, parseJsonBody, parseQuery } from '@/lib/api/request';
import { collection, created } from '@/lib/api/responses';
import { createMealPlanRepository } from '@/server/meal-plans/repository';
import { createMealPlan, listMealPlans } from '@/server/meal-plans/service';
import { createMealPlanBodySchema, listMealPlansQuerySchema, mealPlanCursorSchema, toMealPlanDto } from './contract';

const ROUTE = '/api/v1/meal-plans';
// Platform limit for this function, in seconds. Next.js requires a literal here, so it can't be read from config;
// keep it above apiConfig.timeouts.handlerMs so withApi answers a controlled 503 first.
export const maxDuration = 30;

export const GET = withApi(ROUTE, async (req) => {
  assertAcceptsJson(req);
  const principal = await requireAuth(req);
  const { cursor: rawCursor, ...filter } = parseQuery(req, listMealPlansQuerySchema);

  const cursor = rawCursor ? decodeCursor(rawCursor, mealPlanCursorSchema) : null;
  if (cursor && cursor.sort !== filter.sort) {
    // A cursor is only valid for the ordering it was issued for.
    throw new ApiError('INVALID_PARAMETERS', 'The cursor does not match the requested sort.');
  }

  const rows = await listMealPlans(createMealPlanRepository(principal), filter, cursor);
  const { items, hasMore } = splitPage(rows, filter.limit);
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ sort: filter.sort, created_at: last.created_at, id: last.public_id }) : null;

  return collection(
    items.map(toMealPlanDto),
    { limit: filter.limit, has_more: hasMore, next_cursor: nextCursor },
    pageLinks(req, nextCursor),
  );
});

export const POST = withApi(ROUTE, async (req) => {
  assertAcceptsJson(req);
  const principal = await requireAuth(req);
  const body = await parseJsonBody(req, createMealPlanBodySchema);

  // Creating a draft plan twice is harmless and user-visible, so no Idempotency-Key here. Operations that charge,
  // notify or provision wrap their work in withIdempotency (lib/api/idempotency.ts).
  const row = await createMealPlan(createMealPlanRepository(principal), body);
  const dto = toMealPlanDto(row);
  return created(dto, `${ROUTE}/${dto.id}`, { headers: { ETag: etagFor(row.version) } });
});
