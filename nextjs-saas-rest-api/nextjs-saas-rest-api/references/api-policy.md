# API Policy (normative text)

This is the authoritative policy. `SKILL.md` summarizes and operationalizes it; when the two
disagree, this file wins.

## Contents

- [API Policy](#api-policy)
- [API versioning](#api-versioning)
- [Endpoint and resource design](#endpoint-and-resource-design)
- [HTTP semantics and status codes](#http-semantics-and-status-codes)
- [Request validation and response contracts](#request-validation-and-response-contracts)
- [Pagination, filtering, and limits](#pagination-filtering-and-limits)
- [Security, authorization, and reliability](#security-authorization-and-reliability)
- [API testing and compatibility](#api-testing-and-compatibility)

## API Policy

Default to REST via Next.js Route Handlers. Server Actions are for server-bound UI mutations or flows that do not need a
public HTTP contract; do not expose a Server Action as an accidental public API. Add Route Handlers under
`src/app/api/v{major}/...` when an HTTP endpoint is required.

### API versioning

- Every public API endpoint MUST include an explicit major version in its path: `/api/v1/...`. Never create an unversioned
  alias such as `/api/...` for a public contract.
- The major version changes only for breaking changes: removing or renaming fields, changing field meaning or types,
  changing required inputs, changing authentication/authorization semantics, or changing status/error behavior in a way that
  can break clients.
- Backward-compatible additions—optional request fields, response fields, new resources, and new query filters—remain in the
  current major version. Clients MUST ignore unknown response fields.
- Keep each major version independently understandable and testable. Do not branch behavior throughout a handler with
  scattered version checks; route versions to explicit versioned contracts and services where behavior differs.
- Do not silently change the meaning of an existing field or endpoint. Introduce a new field, endpoint, or major version and
  document the migration.
- When deprecating a version or endpoint, publish the successor, migration notes, and a sunset date. During the migration
  period return `Deprecation` and `Sunset` headers plus a `Link` header with `rel="successor-version"` or `rel="alternate"`.
  Do not remove the old contract before the announced sunset unless there is a documented security or legal requirement.
- Version changes MUST include contract tests and an entry in the changelog or API migration documentation.

### Endpoint and resource design

- Use plural, lowercase, kebab-case resource names: `/api/v1/meal-plans` and `/api/v1/meal-plans/{id}`. Use stable opaque
  identifiers; do not expose database implementation details when a public identifier is available.
- Prefer resource-oriented endpoints for CRUD:
  - `GET /resources`
  - `GET /resources/{id}`
  - `POST /resources`
  - `PATCH /resources/{id}`
  - `PUT /resources/{id}` only when full replacement semantics are intentional
  - `DELETE /resources/{id}`
- Use query parameters for filtering, sorting, field selection, and pagination. Do not create separate read-only paths for
  every filter, such as `/resources/active`; use `/resources?status=active`.
- Use dedicated action endpoints only for a domain command with meaningful side effects or orchestration that is not a simple
  attribute update, such as `/resources/{id}/complete` or `/resources/{id}/sync`.
- Avoid action endpoints for ordinary updates: use `PATCH /resources/{id}` with `{ "owner_id": "..." }`, not
  `/resources/{id}/assign-owner`.
- Avoid duplicate paths for the same behavior. If a legacy path must remain, mark it deprecated and define one canonical
  successor.
- Use `Content-Type: application/json` for JSON requests and return JSON consistently. Reject unsupported media types with
  `415` and unsupported response formats with `406` when content negotiation is implemented.

### HTTP semantics and status codes

- Use HTTP methods and status codes according to their semantics; do not return `200` for every outcome.
- Use `200` for successful reads or updates with a response body, `201` for creation, and `204` for successful operations with
  no response body. Include a `Location` header on `201` responses when the created resource has a canonical URL.
- Use `400` for malformed requests, `401` for missing or invalid authentication, `403` for authenticated callers without
  permission, `404` when the resource is not visible or does not exist, `409` for state or uniqueness conflicts, `412` for
  failed conditional requests, `415` for unsupported media types, `422` for semantically invalid but well-formed input, `429`
  for rate limits, and `500`/`503` for server or dependency failures.
- Preserve idempotency: `GET`, `HEAD`, `PUT`, and `DELETE` MUST be safe to retry according to their semantics. Retry-sensitive
  `POST` operations MUST support an `Idempotency-Key` when duplicate execution could create a material side effect.
- Support conditional updates with `ETag` and `If-Match` when lost updates are possible. Do not overwrite a newer resource
  silently.

### Request validation and response contracts

- Treat `params`, `searchParams`, headers, cookies, request bodies, uploads, and external responses as untrusted `unknown`
  data. Parse them at the Route Handler boundary with Zod before business logic or database access.
- Define separate schemas for path params, query params, request bodies, and response data. Reject invalid input before doing
  side effects. Reject or explicitly account for unknown write fields; never pass raw request objects to the database or any other
  persistence layer.
- Keep API DTOs separate from database rows. Map and allowlist fields explicitly so internal columns, secrets, audit fields,
  and authorization metadata cannot leak or be mass-assigned.
- Use one predictable success shape per endpoint family. For collections, return `{ "data": [...], "meta": {...}, "links": {...} }`;
  for a single resource, return `{ "data": {...} }`. Do not mix envelopes or return database rows directly.
- Use a stable machine-readable error shape, for example:
  `{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [...] , "request_id": "..." } }`.
  Error codes are for clients; messages are safe and actionable. Never expose stack traces, SQL, provider responses, tokens,
  or secrets. Keep sensitive detail in server logs only.
- Document required fields, nullable fields, enum values, limits, examples, and error codes. Public or consumed APIs MUST have
  an OpenAPI contract or an equivalent versioned schema, kept in sync with runtime validation.

### Pagination, filtering, and limits

- Collection endpoints MUST define a deterministic order and bounded page size. Prefer cursor pagination for data that changes
  frequently or can grow large; use offset pagination only when its consistency and limits are acceptable.
- Validate and cap `limit`/`page_size`; never let clients select unrestricted result sizes. Return pagination metadata and links
  that allow clients to continue without reconstructing URLs.
- Allowlist filter and sort fields and validate operators. Do not interpolate client-provided field names, SQL fragments, or
  sort expressions into queries.
- Keep list responses bounded and avoid N+1 database queries. Fetch only fields needed by the response contract.

### Security, authorization, and reliability

- Authenticate and authorize every protected endpoint server-side. Enforce ownership and tenant boundaries in application
  logic and PostgreSQL RLS; default to deny when identity or scope is missing.
- Configure CORS with an explicit allowlist, apply security headers, enforce request-body and upload-size limits, and rate-limit
  public or abuse-prone endpoints. Never use `Access-Control-Allow-Origin: *` for credentialed APIs.
- Keep secrets server-side and out of responses, logs, URLs, and client bundles. Redact authorization headers, cookies, email
  addresses, and other sensitive values from structured logs unless there is an approved operational need.
- Use transactions for multi-write invariants and database constraints for uniqueness, referential integrity, and state rules.
  Do not rely on a read-then-write race-prone check when a constraint or atomic operation can enforce the rule.
- Set explicit timeouts for outbound calls, use bounded retries only for transient and idempotent operations, and return
  controlled `503` responses when a dependency is unavailable. Never retry a non-idempotent operation without an idempotency
  key or equivalent deduplication.
- Emit a request/correlation ID, structured logs, latency and status metrics, and dependency failure metrics. Return the
  request ID in the response error shape so incidents can be traced without exposing internals.

### API testing and compatibility

- Test each endpoint for authentication, authorization/RLS scope, validation failures, success responses, not-found behavior,
  conflict handling, rate limits where applicable, and dependency failures.
- Add contract tests for response schemas and status codes. For every new major version, test representative clients against
  the old and new contracts during the migration period.
- Do not use destructive database migrations or reset shared data in API tests. Use isolated fixtures or explicitly provisioned
  test data and verify that tests cannot target production.
