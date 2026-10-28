// src/server/domain-errors.ts
// Services and repositories throw these instead of HTTP errors, so business logic stays independent of the API
// version, the transport and the database client. src/lib/api/errors.ts maps each kind to a status code.
export type DomainErrorKind = 'not_found' | 'forbidden' | 'conflict' | 'precondition_failed' | 'invalid' | 'unavailable';

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    message: string,
    readonly code?: string, // stable client code, e.g. 'MEAL_PLAN_NOT_ACTIVE'
    readonly details?: { path?: string; code: string; message: string }[],
    readonly dependency?: string, // for 'unavailable': which dependency failed
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DomainError';
  }
}
