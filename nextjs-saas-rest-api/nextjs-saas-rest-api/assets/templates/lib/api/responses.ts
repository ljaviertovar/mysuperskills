// src/lib/api/responses.ts
// One envelope per endpoint family: { data } for a resource, { data, meta, links } for a collection.
// Cursor pagination adds `next_cursor`; offset pagination adds `offset`. `limit` and `has_more` are always present.
export type CollectionMeta = { limit: number; has_more: boolean; next_cursor?: string | null } & Record<string, unknown>;
export type CollectionLinks = { self: string; next: string | null } & Record<string, string | null>;

function withHeaders(init: ResponseInit | undefined, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, { ...init, status: 200, headers: withHeaders(init) });
}

// `location` is the canonical URL of the new resource, e.g. `/api/v1/meal-plans/${dto.id}`.
export function created<T>(data: T, location: string, init?: ResponseInit): Response {
  return Response.json({ data }, { ...init, status: 201, headers: withHeaders(init, { Location: location }) });
}

export function noContent(init?: ResponseInit): Response {
  return new Response(null, { ...init, status: 204, headers: withHeaders(init) });
}

export function collection<T>(data: T[], meta: CollectionMeta, links: CollectionLinks, init?: ResponseInit): Response {
  return Response.json({ data, meta, links }, { ...init, status: 200, headers: withHeaders(init) });
}
