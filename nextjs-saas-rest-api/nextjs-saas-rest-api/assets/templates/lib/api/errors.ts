// src/lib/api/errors.ts
// Standard error shape: { error: { code, message, details?, request_id } }.
// Codes are stable and machine-readable; messages are safe for clients. Internal detail goes to logs only.
import { apiConfig } from '@/config/api';
import { DomainError, type DomainErrorKind } from '@/server/domain-errors';
import { logger } from './logger';

const STANDARD_STATUS = {
  BAD_REQUEST: 400,
  INVALID_PARAMETERS: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403, // cookie-authenticated mutation from a foreign origin
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  GONE: 410,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  PRECONDITION_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 503, // the handler exceeded apiConfig.timeouts.handlerMs
} as const;

export type StandardErrorCode = keyof typeof STANDARD_STATUS;
// Domain-specific codes (e.g. 'MEAL_PLAN_NOT_ACTIVE') are allowed but must pass an explicit status.
export type ApiErrorCode = StandardErrorCode | (string & {});

export type ErrorDetail = { path?: string; code: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: ErrorDetail[];
  readonly headers?: HeadersInit;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number; details?: ErrorDetail[]; headers?: HeadersInit; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? STANDARD_STATUS[code as StandardErrorCode] ?? 500;
    this.details = options.details;
    this.headers = options.headers;
  }
}

const DOMAIN_KIND_TO_HTTP: Record<DomainErrorKind, { status: number; fallbackCode: StandardErrorCode }> = {
  not_found: { status: 404, fallbackCode: 'NOT_FOUND' },
  forbidden: { status: 403, fallbackCode: 'FORBIDDEN' },
  conflict: { status: 409, fallbackCode: 'CONFLICT' },
  precondition_failed: { status: 412, fallbackCode: 'PRECONDITION_FAILED' },
  invalid: { status: 422, fallbackCode: 'VALIDATION_FAILED' },
  unavailable: { status: 503, fallbackCode: 'SERVICE_UNAVAILABLE' },
};

export function toErrorResponse(err: unknown, requestId: string, context: { route: string; method: string }): Response {
  let apiError: ApiError;

  if (err instanceof ApiError) {
    apiError = err;
  } else if (err instanceof DomainError) {
    const mapping = DOMAIN_KIND_TO_HTTP[err.kind];
    apiError = new ApiError(err.code ?? mapping.fallbackCode, err.message, {
      status: mapping.status,
      details: err.details,
      headers: err.kind === 'unavailable' ? { 'Retry-After': String(apiConfig.timeouts.retryAfterSeconds) } : undefined,
    });
    if (err.kind === 'unavailable') {
      logger.warn('api.dependency_unavailable', { ...context, request_id: requestId, dependency: err.dependency, error: err });
    }
  } else {
    // Unknown error: log everything server-side, return nothing internal.
    logger.error('api.unhandled_error', { ...context, request_id: requestId, error: err });
    apiError = new ApiError('INTERNAL_ERROR', 'An unexpected error occurred. Contact support with the request_id.');
  }

  const headers = new Headers(apiError.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details?.length ? { details: apiError.details } : {}),
        request_id: requestId,
      },
    }),
    { status: apiError.status, headers },
  );
}
