// src/lib/api/request.ts
// Boundary parsing. Everything from the request is `unknown` until a Zod schema accepts it.
// Convention: malformed transport or invalid path/query -> 400; well-formed body failing the schema -> 422.
import { z } from 'zod';
import { apiConfig } from '@/config/api';
import { ApiError, type ErrorDetail } from './errors';

// Route Handlers have no built-in body limit; the default comes from src/config/api.ts.

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/i;

export function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || undefined,
    code: issue.code,
    message: issue.message,
  }));
}

export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }

  const maxBytes = options.maxBytes ?? apiConfig.body.maxBytes;
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', `Request body must not exceed ${maxBytes} bytes.`);
  }

  const text = await readTextWithLimit(req, maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError('BAD_REQUEST', 'Request body is not valid JSON.');
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError('VALIDATION_FAILED', 'Request body is invalid.', { details: zodDetails(result.error) });
  }
  return result.data;
}

async function readTextWithLimit(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError('PAYLOAD_TOO_LARGE', `Request body must not exceed ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// Repeated keys become arrays (?status=a&status=b), single keys stay strings.
export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.output<S> {
  const params = new URL(req.url).searchParams;
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : values[0];
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError('INVALID_PARAMETERS', 'Query parameters are invalid.', { details: zodDetails(result.error) });
  }
  return result.data;
}

export async function parseParams<S extends z.ZodType>(params: Promise<unknown>, schema: S): Promise<z.output<S>> {
  const result = schema.safeParse(await params);
  if (!result.success) {
    throw new ApiError('INVALID_PARAMETERS', 'Path parameters are invalid.', { details: zodDetails(result.error) });
  }
  return result.data;
}

// Call when the endpoint only produces JSON and the client sent an Accept header.
export function assertAcceptsJson(req: Request): void {
  const accept = req.headers.get('accept');
  if (!accept) return;
  const ok = accept
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase())
    .some((type) => type === '*/*' || type === 'application/*' || type === 'application/json' || type.endsWith('+json'));
  if (!ok) throw new ApiError('NOT_ACCEPTABLE', 'This endpoint only produces application/json.');
}
