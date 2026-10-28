# Implementation patterns

Read only the section you need (`grep -n '^## ' references/patterns.md` lists them). Code assumes the helpers
installed by `scripts/install-helpers.mjs` (imported as `@/lib/api/*` and `@/server/*`). The data layer and the
authentication provider are the project's own: nothing here depends on a specific database, ORM or auth vendor.

## Contents

- Minimal profile
- Resolving the principal
- CSRF
- Idempotency
- Rate limiting
- CORS
- Invariants and transactions
- Database-level tenant isolation
- Contract changes that touch storage (expand and contract)
- Indexes
- Optimistic concurrency (ETag / If-Match) and conditional GET
- Domain command endpoints
- Outbound URLs and SSRF
- Webhook receivers
- Metrics from structured logs
- OpenAPI from Zod
- Introducing v2 and deprecating v1
- Test data safety

---

## Minimal profile

For a simple CRUD resource (single user or single tenant, used by this app's UI, no retries or concurrency
concerns). It keeps the mandatory baseline (server-side auth, ownership, Zod, explicit fields, safe errors) and
adds no layers: the handler calls the project's own data access. Shown for a user-owned `notes` resource;
`@/server/notes` stands for whatever the project uses (ORM, SQL helper, existing service).

```ts
// src/app/api/v1/notes/contract.ts
import { z } from 'zod';
import { limitSchema } from '@/lib/api/pagination';

export const noteParamsSchema = z.strictObject({ id: z.uuid() });
export const listNotesQuerySchema = z.strictObject({
  limit: limitSchema, // bounded by apiConfig
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const title = z.string().trim().min(1).max(200);
const text = z.string().max(10_000);
export const createNoteBodySchema = z.strictObject({ title, body: text.default('') });
// PATCH is written out: .partial() would re-apply body's default and wipe the stored text.
export const updateNoteBodySchema = z
  .strictObject({ title: title.optional(), body: text.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });

export type NoteRecord = { id: string; ownerId: string; title: string; body: string; createdAt: Date };
// Explicit public fields: ownerId and any internal column never leave the API.
export const toNoteDto = (n: NoteRecord) => ({ id: n.id, title: n.title, body: n.body, created_at: n.createdAt.toISOString() });
```

```ts
// src/app/api/v1/notes/route.ts
import { requireAuth } from '@/lib/api/auth';
import { withApi } from '@/lib/api/handler';
import { parseJsonBody, parseQuery } from '@/lib/api/request';
import { collection, created } from '@/lib/api/responses';
import { notes } from '@/server/notes'; // the project's data access
import { createNoteBodySchema, listNotesQuerySchema, toNoteDto } from './contract';

const ROUTE = '/api/v1/notes';
export const maxDuration = 30; // literal, above apiConfig.timeouts.handlerMs

export const GET = withApi(ROUTE, async (req) => {
  const { userId } = await requireAuth(req);
  const { limit, offset } = parseQuery(req, listNotesQuerySchema);
  // Ownership in the query. Deterministic order: created_at desc, id desc. One extra row tells whether more exist.
  const rows = await notes.listForOwner(userId, { limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const url = new URL(req.url);
  return collection(
    rows.slice(0, limit).map(toNoteDto),
    { limit, offset, has_more: hasMore },
    { self: `${url.pathname}${url.search}`, next: hasMore ? `${ROUTE}?limit=${limit}&offset=${offset + limit}` : null },
  );
});

export const POST = withApi(ROUTE, async (req) => {
  const { userId } = await requireAuth(req);
  const input = await parseJsonBody(req, createNoteBodySchema);
  const note = await notes.create({ ownerId: userId, title: input.title, body: input.body }); // field by field
  const dto = toNoteDto(note);
  return created(dto, `${ROUTE}/${dto.id}`);
});
```

```ts
// src/app/api/v1/notes/[id]/route.ts
import { requireAuth } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { withApi } from '@/lib/api/handler';
import { parseJsonBody, parseParams } from '@/lib/api/request';
import { noContent, ok } from '@/lib/api/responses';
import { notes } from '@/server/notes';
import { noteParamsSchema, toNoteDto, updateNoteBodySchema } from '../contract';

const ROUTE = '/api/v1/notes/[id]';
type Ctx = RouteContext<'/api/v1/notes/[id]'>;
export const maxDuration = 30;
const notFound = () => new ApiError('NOT_FOUND', 'Note not found.'); // also for notes owned by someone else

export const GET = withApi<Ctx>(ROUTE, async (req, { params }) => {
  const { userId } = await requireAuth(req);
  const { id } = await parseParams(params, noteParamsSchema);
  const note = await notes.findForOwner(userId, id); // WHERE id = $1 AND owner_id = $2
  if (!note) throw notFound();
  return ok(toNoteDto(note));
});

export const PATCH = withApi<Ctx>(ROUTE, async (req, { params }) => {
  const { userId } = await requireAuth(req);
  const { id } = await parseParams(params, noteParamsSchema);
  const patch = await parseJsonBody(req, updateNoteBodySchema);
  const note = await notes.updateForOwner(userId, id, patch); // one statement, ownership in the WHERE
  if (!note) throw notFound();
  return ok(toNoteDto(note));
});

export const DELETE = withApi<Ctx>(ROUTE, async (req, { params }) => {
  const { userId } = await requireAuth(req);
  const { id } = await parseParams(params, noteParamsSchema);
  if (!(await notes.deleteForOwner(userId, id))) throw notFound();
  return noContent();
});
```

Tests (Vitest, same pattern as the full profile, with the data access mocked): 401 without credentials, another
user's note answers 404, an unknown body field answers 422 and writes nothing, a PATCH with only `title` keeps
`body`, success shapes, and `limit` above the cap answers 400. Unneeded here unless a trigger from *What the
context turns on* is true: tenant scoping, cursor pagination, `Idempotency-Key`, `ETag`, rate limit, OpenAPI.

## Resolving the principal

`src/lib/api/principal.ts` is the only file that knows how callers authenticate. Whatever the mechanism, the rules
are the same: verify on the server, take tenant and role from server-controlled data, return `null` when there is
no valid credential, never accept credentials in a query string.

- **Bearer JWT from an identity provider (JWKS):** verify signature, expiry, issuer, audience and the algorithm.

  ```ts
  import { createRemoteJWKSet, jwtVerify } from 'jose';
  const jwks = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL!)); // cached and rotated by jose

  export async function resolvePrincipal(req: Request): Promise<Principal | null> {
    const token = /^Bearer (\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: process.env.AUTH_ISSUER!, audience: process.env.AUTH_AUDIENCE!, algorithms: ['RS256', 'ES256'],
      });
      // Claim names vary by provider; or look the membership up by payload.sub in your own data.
      if (!payload.sub || typeof payload.org_id !== 'string') return null;
      return { userId: payload.sub, tenantId: payload.org_id, role: String(payload.role ?? 'member') };
    } catch {
      return null; // expired, wrong audience, bad signature...
    }
  }
  ```

- **Session cookie (Auth.js and similar):** call the library's server-side session getter, then load the
  membership. **API key:** hash the presented key and compare against stored hashes (constant time); the key row
  carries tenant and scopes.
- A stateless token can't be revoked before it expires: keep lifetimes short, and for sensitive operations
  (credential or billing changes, role changes, deleting a workspace) also check a denylist or ask the provider.

## CSRF

`withApi` already blocks the attack; this section is about configuring and reasoning about it.

- **When it applies:** a state-changing method (`POST`, `PUT`, `PATCH`, `DELETE`) that carries a cookie and no
  `Authorization` header. Bearer tokens and API keys are explicit credentials a third-party site can't make the
  browser send, and a request without cookies has nothing to ride on.
- **The check:** the `Origin` host must equal this host (`Host` or `X-Forwarded-Host`) or appear in
  `API_ALLOWED_ORIGINS`; without `Origin`, `Sec-Fetch-Site: cross-site | same-site` is rejected. Failure → 403
  `CSRF_REJECTED`. Non-browser clients send neither header and are not affected.
- **Cookies:** `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`), scoped to the app's host. `SameSite` alone is not
  enough: same-site subdomains and old browsers bypass it, hence the origin check.
- **Separate frontend origin** (`app.example.com` calling `api.example.com` with cookies): add it to
  `API_ALLOWED_ORIGINS`, which also feeds the CORS allowlist.
- **Never** make a state change reachable with `GET`, and never disable the check for a route that accepts cookies.

### Without `withApi` (a project with its own handler wrapper)

Route Handlers have no CSRF protection of their own, so a project that keeps its wrapper still needs the check. Put
it where every request already passes, `proxy.ts` (Next 16; `middleware.ts` in 15), as a pure function that is
easy to test:

```ts
// src/lib/api/csrf.ts
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isForeignOriginMutation(request: Request, extraAllowed = process.env.API_ALLOWED_ORIGINS ?? ''): boolean {
  if (SAFE.has(request.method.toUpperCase())) return false
  if (request.headers.get('authorization') || !request.headers.get('cookie')) return false
  const origin = request.headers.get('origin')
  if (!origin) return request.headers.get('sec-fetch-site') === 'cross-site'
  if (origin === new URL(request.url).origin) return false
  return !extraAllowed.split(',').map(v => v.trim()).filter(Boolean).includes(origin)
}

// proxy.ts, before the session refresh
if (request.nextUrl.pathname.startsWith('/api/') && isForeignOriginMutation(request)) {
  const requestId = crypto.randomUUID()
  return NextResponse.json(
    { error: { code: 'CSRF_REJECTED', message: 'Cross-site request refused', request_id: requestId } },
    { status: 403, headers: { 'x-request-id': requestId } }
  )
}
```

Test: foreign origin with cookie gives true; same origin, allowlisted origin, bearer token, no cookie, no `Origin`
and `GET` give false.

## Adapting an existing error helper

A project that already has an error class and a `withHandler` wrapper keeps them. What to change is small and sits
in one file: the places that build a 5xx from `error.message` become one helper that logs the code and answers a
generic message, and the mapper masks exceptions nobody expected.

```ts
export function internalError(error: unknown, context: string) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null
  console.error(`[${context}] call failed`, { code })           // the code, never the message: it can carry values
  return new ApiServiceError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.')
}

// a "no rows" answer from a single-row query is a 404, any other failure is internalError
export function singleRowError(error: { code?: string | null }, context: string) {
  return error.code === 'PGRST116' ? new ApiServiceError(404, 'NOT_FOUND', 'Not found') : internalError(error, context)
}

export function fromUnknownError(error: unknown, requestId: string) {
  if (error instanceof ApiServiceError) return failure(error.status, error.code, error.message, { details: error.details, requestId })
  console.error('[api] unexpected error', { request_id: requestId, error: error instanceof Error ? error.message : String(error) })
  return failure(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.', { requestId })
}
```

Messages the project wrote on purpose for a 5xx ("Could not complete the session") stay: the mapper masks only
exceptions that are not the project's own error class. Then replace `throw new ApiServiceError(500, ..., x.message)`
with `throw internalError(x, '<service>')` by a scripted search and replace (the PostgREST code above belongs to that
client; use your driver's "no rows" signal). The wrapper also sets `x-request-id` on every response. Tests: a
database error never appears in the body, the body's `request_id` equals the header, a 4xx keeps its message.

## Idempotency

Use `withIdempotency` (`lib/api/idempotency.ts`) on any POST whose duplicate execution has a material side effect:
charging, refunding, sending, provisioning, calling a third party. It handles the header, the payload hash, replay,
409 while in flight and 422 on reuse with another payload.

```ts
export const POST = withApi(ROUTE, async (req) => {
  const principal = await requireAuth(req);
  const body = await parseJsonBody(req, createRefundBodySchema);
  return withIdempotency(
    req,
    { store: idempotencyStore, scope: `${principal.tenantId}:${principal.userId}:POST ${ROUTE}`, payload: body, required: true },
    async () => {
      const refund = await createRefund(createRefundRepository(principal), body); // the side effect
      const dto = toRefundDto(refund);
      return { status: 201, body: { data: dto }, headers: { Location: `${ROUTE}/${dto.id}` } };
    },
  );
});
```

`idempotencyStore` implements `IdempotencyStore` with the project's storage (a table with a UNIQUE constraint on
`(scope, key)` plus `request_hash`, `status`, `response`, `created_at`; or Redis `SET NX` with a TTL). `claim` must
be atomic: insert-or-read in one statement, never read-then-insert. Expire rows after
`apiConfig.idempotency.ttlHours` (default 48 h) with a scheduled cleanup. When a third party
supports idempotency keys, forward one derived from yours so the external side effect is deduplicated too.
`createMemoryIdempotencyStore()` exists for tests only.

## Rate limiting

`enforceRateLimit(limiter, policy, key)` (`lib/api/rate-limit.ts`) throws a 429 with `Retry-After` and returns the
`RateLimit-Policy` / `RateLimit` headers (IETF draft) to attach to successful responses. Implement `RateLimiter`
with a store shared by all instances (Redis `INCR` + `EXPIRE`, a KV store, or an atomic upsert in the database);
in-memory counters don't work on serverless. Key by tenant or user on authenticated routes and by IP on anonymous
ones (sign-in, sign-up, password reset), with a lower quota for expensive or abuse-prone endpoints.

```ts
// Quotas and windows come from src/config/api.ts (API_RATE_LIMIT_* variables); never inline them.
const headers = await enforceRateLimit(rateLimiter, apiConfig.rateLimit.default, principal.tenantId);
return ok(dto, { headers });

// Sign-in, password reset, exports, other abuse-prone or expensive endpoints:
await enforceRateLimit(rateLimiter, apiConfig.rateLimit.sensitive, clientIp);
```

Add a new policy to `apiConfig.rateLimit` (with its env variables) rather than creating one inline.

## CORS

Skip CORS if the API is only called same-origin or server-to-server. Otherwise keep an explicit allowlist and
reflect only allowed origins; never fall back to `*`, and never combine `*` with credentials.

```ts
import { apiConfig } from '@/config/api'; // API_ALLOWED_ORIGINS, shared with the CSRF check

export function applyCors(req: Request, headers: Headers): void {
  const origin = req.headers.get('origin');
  headers.append('Vary', 'Origin');
  if (!origin || !apiConfig.origins.allowed.includes(origin)) return; // the browser blocks it
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Expose-Headers', 'ETag, Location, x-request-id, Retry-After, RateLimit, RateLimit-Policy, Deprecation, Sunset, Link');
}
```

Answer preflight with `OPTIONS` (204; `Access-Control-Allow-Methods`, `-Headers: Authorization, Content-Type,
Idempotency-Key, If-Match, x-request-id`, `-Max-Age: 600`), either per route or centrally in `proxy.ts` (the
Next.js 16 name for middleware, Node.js runtime) with a matcher for `/api/v:version/:path*`.

## Invariants and transactions

Rules that must hold even under concurrency belong to the database, not to a read-then-write check in code:
uniqueness, referential integrity and state rules as constraints; counters and state transitions as one atomic
statement (`UPDATE ... WHERE state = 'open'`, an upsert, a conditional write). When several writes must succeed or
fail together, put them in ONE repository method that uses the data layer's transaction API, so the service sees a
single operation. After an atomic attempt that matched nothing, re-read only to decide *why* (404 vs 409 vs 412).

## Database-level tenant isolation

Multi-tenant apps enforce the tenant in two places. The first wall is the tenant filter in every data-access
function. The second is a control in the database itself, so that one forgotten `where` (a new query, a raw SQL
helper, an ad hoc script) cannot expose another tenant's rows. Always say in the reply which second wall the
solution has, adds or recommends, or why there is none. Options, from strongest to simplest:

| Option | How | Trade-off |
|---|---|---|
| Row-level security (PostgreSQL) | Policies compare each row's tenant to a per-transaction setting the app sets | Best default for shared tables; needs a non-owner role and a transaction per request |
| Schema per tenant | One schema per tenant, `search_path` chosen per request | Strong isolation, harder migrations at scale |
| Database or credentials per tenant | Separate database or role per tenant | Strongest, most operational cost |
| No database support (the store lacks it) | A single data-access wrapper that injects the tenant into every query, plus tests that try to cross tenants | Only one wall: say so and keep the wrapper the sole entry point |

Row-level security sketch (PostgreSQL; adapt names):

```sql
ALTER TABLE meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_plans FORCE ROW LEVEL SECURITY;           -- applies to the table owner too
CREATE POLICY tenant_isolation ON meal_plans
  USING (tenant_id = current_setting('app.tenant_id', true))        -- cast to the column type if it isn't text,
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));  -- e.g. current_setting(...)::uuid
```

```ts
// Per request, inside one transaction (the setting is local to it, so pooled connections never leak it):
//   SELECT set_config('app.tenant_id', $1, true)   -- $1 = principal.tenantId
// then run the repository queries on that same transaction.
```

- The application's database role must not own the tables and must not have `BYPASSRLS`; migrations run with a
  different role.
- Missing setting means no rows (the `true` argument returns NULL, which matches nothing): the failure mode is
  empty, not leaky.
- Test it: as tenant A, read and write tenant B's row through the repository with the app role and expect nothing.
- With a pooled connection and no per-request transaction, a session-level setting can leak between requests, so
  don't use `SET` without `LOCAL`.

## Contract changes that touch storage (expand and contract)

When a breaking change needs different stored data (a new column, a retyped or renamed field), the database moves
in two additive-first steps, never as one destructive migration, because v1 keeps serving until the sunset date.

1. **Expand (same change as v2):** add the new columns (nullable or with a safe default), backfill existing rows
   exactly, add a consistency `CHECK` between old and new values, and keep the old column. Until every writer
   uses the new column, keep both in sync with a trigger or dual writes. Nothing is dropped or retyped here.
2. **Migrate:** deploy v2 and v1's deprecation headers together; move internal writers and readers to the new
   column; watch v1 usage per client until it reaches zero or the sunset date passes.
3. **Contract (after the sunset date, separate later migration):** drop the sync trigger, then the old column.
   Write this migration now as a commented or clearly dated file so it isn't forgotten, but don't apply it early.

```sql
-- Expand: money kept as integer minor units next to the legacy decimal column (PostgreSQL syntax).
ALTER TABLE invoices ADD COLUMN amount_cents bigint, ADD COLUMN currency char(3);

-- Exact backfill: decimal arithmetic only, never floating point, and refuse values that don't convert exactly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE amount * 100 <> trunc(amount * 100)) THEN
    RAISE EXCEPTION 'amount has more than 2 decimals; review these rows before migrating';
  END IF;
END $$;
UPDATE invoices SET amount_cents = (amount * 100)::bigint, currency = 'EUR' WHERE amount_cents IS NULL;

ALTER TABLE invoices ADD CONSTRAINT invoices_amount_consistent CHECK (amount_cents IS NULL OR amount_cents = (amount * 100)::bigint);
-- Contract, after the sunset: DROP the trigger, then ALTER TABLE invoices DROP COLUMN amount;
```

- Large tables: backfill in batches (by id ranges) and add `NOT NULL` or constraints as `NOT VALID` then validate.
- Rehearse on a copy of production data first; a migration that can't run on real data is a failed migration.
- If the change needs no new storage (the new shape can be computed from existing columns), derive it at read time
  with exact arithmetic and say so in the reply instead of adding a migration.
- If the project has no migration tooling in sight, provide the SQL files and say where they go.

## Indexes

Keyset pagination is only fast when an index matches the `ORDER BY` exactly, and tenant scoping is only cheap when
the tenant column leads it. For each list endpoint, in the migration tool the project uses:

```sql
-- PostgreSQL syntax; adapt to the project's database. One index per (filter combination, order) the API offers.
CREATE INDEX meal_plans_tenant_created_idx
  ON meal_plans (tenant_id, created_at DESC, public_id DESC) WHERE deleted_at IS NULL;
CREATE INDEX meal_plans_tenant_status_created_idx
  ON meal_plans (tenant_id, status, created_at DESC, public_id DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX meal_plans_public_id_key ON meal_plans (public_id);
```

- Column order: tenant first, then equality filters, then the sort column, then the tie-breaker; directions equal
  to the `ORDER BY` (or all reversed). A filter the API allows but no index covers becomes a scan.
- Partial indexes (`WHERE deleted_at IS NULL`) keep soft-deleted rows out of every lookup.
- Unique constraints double as the indexes for idempotency keys `(scope, key)` and natural keys.
- Check the plan of each list query once (`EXPLAIN`) on realistic data before shipping.

## Optimistic concurrency (ETag / If-Match) and conditional GET

- Keep a `version` column (integer, bumped on every update) and return `ETag: "<version>"` from `GET {id}`,
  `POST`, `PATCH` and `PUT`.
- `requireIfMatch(req)` returns the expected version (428 if the header is missing, 412 if it is malformed).
- The repository applies the update with the version in the same statement; zero rows updated means 404 if the
  record no longer exists, otherwise 412 `PRECONDITION_FAILED`. Never compare in JavaScript and then write.
- If existing clients can't send `If-Match` yet, make it optional in the current major and document last-write-wins;
  make it required in the next major.
- Reads: `return notModified(req, etag) ?? ok(dto, { headers: { ETag: etag } })`. A client that kept the ETag (an
  app cache, a sync job) sends `If-None-Match` and gets 304 with no body. Comparison is weak (`W/"3"` matches `"3"`).
- The default `Cache-Control: private, no-store` stops browsers from storing the body, which is right for sensitive
  data; app clients still benefit from 304 because they keep the ETag themselves. For non-sensitive reads that
  browsers should revalidate, a route may set `Cache-Control: private, no-cache` explicitly.

## Domain command endpoints

`POST /api/v1/refunds/{id}/approve` is justified when the command has side effects or orchestration (events,
notifications, locking edits, a state machine). Shape: strict optional body; 200 with the updated resource
`{ data }` (or 202 plus a job resource when asynchronous); 409 with a domain code (`REFUND_NOT_PENDING`) when the
state machine forbids it; `Idempotency-Key` support when repeating it would duplicate side effects. Not justified:
`/rename`, `/assign-owner`, `/set-status` when it is just a column: use `PATCH`.

## Outbound URLs and SSRF

Whenever the server fetches a URL a client supplied or influenced (webhook subscriptions, "import from URL",
avatars, OAuth callbacks, link previews), treat it as OWASP API7 (SSRF):

- Parse with `new URL()`; allow only `https:`; reject credentials in the URL and non-default ports unless needed.
- Prefer a host allowlist. If arbitrary hosts are a product requirement, resolve DNS and reject private, loopback,
  link-local and metadata ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7) at connection
  time, not only at validation time, to survive DNS rebinding.
- Use `redirect: 'manual'` (or re-validate every hop), cap the response size, and use `fetchWithTimeout`.
- Never return the fetched body or the upstream error verbatim to the client.

## Webhook receivers

Inbound webhooks are a contract with the provider, not part of your public API: put them under
`src/app/api/webhooks/<provider>/route.ts` and keep them out of the public OpenAPI. The same rules apply: read
the raw body with a size cap, verify the signature before parsing, parse the payload with Zod, deduplicate on the
provider's event id with a unique constraint, return 2xx quickly and push slow work to a queue. Resolve the tenant
from the event, and scope every query by it.

## Metrics from structured logs

The API emits JSON log lines with stable fields; the log platform turns them into metrics, so the code needs no
metrics SDK. Keep these names stable, because dashboards and alerts depend on them.

| Event | Fields | Metrics to derive |
|---|---|---|
| `api.request` (one per request, via `after()`) | `route` (template), `method`, `status`, `duration_ms`, `request_id`, `trace_id?` | Requests/min per route; 4xx and 5xx rate; p50/p95/p99 latency per route and method; 429 rate (throttling); 503 `TIMEOUT` rate |
| `api.dependency_attempt_failed` | `dependency`, `attempt`, `status` or `error`, `duration_ms` | Failure rate and latency per dependency; retries per call |
| `api.dependency_unavailable` | `dependency`, `route`, `request_id` | Requests that ended in 503 because of a dependency |
| `api.unhandled_error` | `route`, `method`, `request_id`, `error` | Unexpected 500s per route (alert on any) |

- `route` is the template (`/api/v1/meal-plans/[id]`), never the concrete URL, so cardinality stays low.
- `trace_id` comes from an incoming W3C `traceparent`, so a log line can be joined with the caller's trace.
- Suggested alerts: 5xx rate over 1% for 5 minutes, p95 latency above the route's budget, any `api.unhandled_error`,
  dependency failure rate over 5%.
- If the project later adopts a metrics SDK, emit from the same places (`withApi`, `fetchWithTimeout`,
  `toErrorResponse`) with the same names and labels.

## OpenAPI from Zod

Keep one source of truth: the Zod schemas in each version's `contract.ts`. Use Zod 4's built-in
`z.toJSONSchema` (no extra dependency; with Zod 3 use `@asteasolutions/zod-to-openapi`).

- Give every reusable schema `.meta({ id, description, examples })`; ids become `components/schemas` names.
  `.meta()` is per instance: call it last, after `.refine()` / `.optional()`, or it is lost.
- Generate request bodies with `{ io: 'input' }` (what clients send) and responses with the default output mode.
  Use `target: 'openapi-3.0'` if the tooling needs OAS 3.0.
- A script (`scripts/generate-openapi.ts`) assembles `paths` per version and writes `docs/api/openapi.v1.json`,
  listing every status code and error `code` each operation can return, and stating that clients must ignore
  unknown response fields. CI regenerates it and fails on a diff, so docs can't drift from runtime validation.

```ts
const body = z.toJSONSchema(createMealPlanBodySchema, { io: 'input' });
const dto = z.toJSONSchema(mealPlanDtoSchema);
```

## Introducing v2 and deprecating v1

1. Confirm the change is breaking (SKILL.md, *Versioning*). If it isn't, stay in v1.
2. Create `src/app/api/v2/<resource>/` with its own `contract.ts` (copy v1, change what breaks) and routes. The
   service and model stay shared while behavior is identical; add a separate service function where v2 truly
   behaves differently. No `if (version === ...)` inside handlers. If v2 needs different stored data, ship the
   additive *expand* migration in the same change (section "Contract changes that touch storage").
3. Contract tests for v2, and keep v1's passing, plus a test that representative v1 calls still work.
4. Publish a changelog entry, a migration guide (field mapping old -> new, behavior changes, examples) and a
   sunset date (commonly 6 months or more for external clients), identical in code, changelog and guide.
5. Wrap every v1 handler of the resource, with the SAME info object on each route; the successor link is computed
   per request, so `/api/v1/invoices/42` points at `/api/v2/invoices/42`:

   ```ts
   const V1_DEPRECATION = {
     deprecatedAt: new Date('2026-11-09'), sunsetAt: new Date('2027-05-10'),
     successor: replaceVersion('v1', 'v2'), docs: 'https://docs.example.com/migrate-to-v2',
   };
   export const GET = withDeprecation(V1_DEPRECATION, withApi(ROUTE, handler));
   ```

6. Log v1 usage per client (`api.deprecated_contract_used` with tenant id) to target reminders. Don't remove v1
   before the sunset date unless there is a documented security or legal reason; after it, answer `410 Gone` with the
   standard error shape (code `GONE`) pointing at the successor, rather than 404.

## Test data safety

- Run integration tests against a local or explicitly provisioned test database, never production or a shared
  staging database. Guard the setup so it refuses to run otherwise:

  ```ts
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  if (process.env.NODE_ENV === 'production' || !(isLocal || url === process.env.TEST_DATABASE_URL)) {
    throw new Error(`Refusing to run API integration tests against ${url ? 'this database' : '<unset>'}`);
  }
  ```

- Create fixtures per test (a unique tenant per test file, random ids) and clean up only what that test created.
  No truncating shared tables, no resetting shared databases, no destructive migrations in test setup.
- For tenant isolation, create data as two tenants and assert that tenant B gets 404 for tenant A's resource on
  every method, and never sees it in lists.
