// src/lib/api/pagination.ts
// Bounded page sizes and opaque keyset cursors. The cursor encodes the last row's sort value + unique id,
// plus the sort it was issued for, so a cursor can't be replayed against a different ordering.
import { z } from 'zod';
import { apiConfig } from '@/config/api';
import { ApiError } from './errors';

// Rejects (rather than silently clamps) out-of-range values so clients notice the cap. Sizes: src/config/api.ts.
export const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(apiConfig.pagination.maxSize)
  .default(apiConfig.pagination.defaultSize);
export const cursorParamSchema = z.string().min(1).max(512).optional();

export function encodeCursor<C extends object>(cursor: C): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

// `schema` must strictly validate every field (ISO datetime, UUID...) because values may end up in query filters.
export function decodeCursor<S extends z.ZodType>(raw: string, schema: S): z.output<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError('INVALID_PARAMETERS', 'The cursor is invalid or expired.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new ApiError('INVALID_PARAMETERS', 'The cursor is invalid or expired.');
  return result.data;
}

// Fetch `limit + 1` rows, then split: the extra row only tells us whether another page exists.
export function splitPage<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

// Relative links (path + query) avoid trusting Host headers behind proxies.
export function pageLinks(req: Request, nextCursor: string | null): { self: string; next: string | null } {
  const url = new URL(req.url);
  const self = `${url.pathname}${url.search}`;
  if (!nextCursor) return { self, next: null };
  const next = new URL(url);
  next.searchParams.set('cursor', nextCursor);
  return { self, next: `${next.pathname}${next.search}` };
}
