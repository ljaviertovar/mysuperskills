// src/lib/api/etag.ts
// Strong ETags derived from a monotonically increasing `version` column.
// Writes: the comparison happens in the database (UPDATE ... WHERE version = expected), never read-then-write in JS.
// Reads: clients send the ETag back in If-None-Match and get 304 with no body when nothing changed.
import { ApiError } from './errors';

export function etagFor(version: number): string {
  return `"${version}"`;
}

// Returns the expected version from If-Match. Missing header -> 428; weak/garbled/multiple tags -> 412,
// because If-Match requires a strong comparison against exactly the version the client saw.
export function requireIfMatch(req: Request): number {
  const header = req.headers.get('if-match');
  if (!header) {
    throw new ApiError('PRECONDITION_REQUIRED', 'This update requires an If-Match header with the resource ETag.');
  }
  const match = /^"(\d+)"$/.exec(header.trim());
  if (!match) {
    throw new ApiError('PRECONDITION_FAILED', 'The If-Match header does not match the current resource version.');
  }
  return Number(match[1]);
}

// Conditional GET (RFC 9110): if the client already holds this version, answer 304 with no body.
// If-None-Match uses weak comparison, so W/"3" matches "3". Returns null when the full response must be sent.
export function notModified(req: Request, etag: string, init: { headers?: Record<string, string> } = {}): Response | null {
  const header = req.headers.get('if-none-match');
  if (!header) return null;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const matches = header.trim() === '*' || header.split(',').some((tag) => opaque(tag) === opaque(etag));
  return matches ? new Response(null, { status: 304, headers: { ...init.headers, ETag: etag } }) : null;
}
