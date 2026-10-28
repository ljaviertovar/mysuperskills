---
name: nextjs-saas-rest-api
description: >-
  Use this skill for any HTTP API work in a Next.js App Router + TypeScript backend: creating, changing, reviewing or auditing route.ts endpoints, webhook receivers, and Server Actions that save or mutate data; versioned URLs, error formats, status codes, auth and tenant checks; retries and double submits (idempotency), rate limiting; slow list endpoints (pagination, indexes); database tables, migrations, indexes and row-level security that back an API; and contract evolution (renaming or removing fields, deprecating or versioning an API that clients already depend on). Enforces the team's REST policy (/api/v{major}, Zod, DTOs, error envelope with request_id), scaled to the app's real needs, with any database, ORM or auth provider. Also on casual asks: "add an endpoint", "expose this to the mobile app", "paginate this", "make this retry-safe", "crea un endpoint", "revisa esta ruta". Skip GraphQL/tRPC, pure UI, deployment, e2e browser tests, standalone SQL tuning.
---

# Next.js REST API policy

You are applying a binding team policy, not offering suggestions. The full normative text is in
`references/api-policy.md`; this file turns it into a working procedure, and where the two disagree the policy
file wins. The skill fixes the HTTP layer, validation and security rules. It does not depend on any database,
ORM, auth provider or backend framework: authentication sits behind one `resolvePrincipal` function and, in the
full profile, storage behind a `repository` interface, both written against whatever the project already uses.

Reply in the user's language; keep code, identifiers, URLs, headers and error codes in English. This skill's
files (`references/`, `assets/`, `scripts/`) are for you, not for the user: they don't exist in the user's
repository, so never tell the user to "see `references/patterns.md`"; put the code in their project or explain the
point in your reply.

## Why this policy exists

When an API has clients you don't control (mobile apps, integrations, customers' scripts), every rule protects one
of three things: **clients keep working** (versioning, stable shapes, no silent meaning changes), **data can't
reach the wrong person** (server-side auth, ownership and tenant scoping, allowlisted DTOs) and **incidents are
debuggable without leaking internals** (error codes, request IDs, structured logs). When a case isn't spelled
out, ask which of the three is at stake, and whether it is at stake in this application.

## Complexity budget and context-first design

Before proposing architecture or creating files, inspect the application context:

- Is the app single-user, single-tenant or multi-tenant?
- Are there external API consumers, mobile clients or webhooks?
- Is the endpoint public or only used by this application's UI?
- What authentication, database and project conventions already exist?
- Are concurrency, high traffic, retries or backward compatibility real requirements?

Start with the smallest architecture that satisfies the actual requirements.

For a simple CRUD application, do not add by default:

- Multi-tenant abstractions or `tenant_id`.
- Extra service, repository or domain layers when the project does not use them.
- Cursor pagination, idempotency keys or ETags without a concrete need.
- Queues, events, caching, rate limiting or external orchestration.
- OpenAPI generation when the endpoint is strictly internal and undocumented APIs are acceptable.
- New shared helpers when an existing project helper is sufficient.
- A scaffold or generated architecture solely because it is available.

The following remain mandatory regardless of application size:

- Server-side authentication when the resource is protected.
- Authorization and ownership checks.
- Zod validation for untrusted input.
- Explicit response fields and safe error handling.
- Protection against secret exposure, injection and unauthorized data access.

Ask the user before introducing architecture that materially increases code or maintenance, including
multi-tenancy, CQRS, event-driven flows, new infrastructure, additional persistence layers, caching, background
jobs or complex concurrency controls.

Do not ask for confirmation for straightforward, low-risk implementation choices. Prefer established project
conventions and the simplest safe default.

When a recommended SaaS rule is intentionally omitted because the application does not need it, state the
omission and its reason in the final response.

### What the context turns on

Each rule in this file below the baseline switches on only when its trigger is true for this application.

| If this is true... | ...then add |
|---|---|
| Several customers or workspaces share the tables (multi-tenant) | `tenantId` in the principal, the tenant filter in every query, cross-tenant tests, a database-level wall where the store supports it, 404 for other tenants' records |
| Single-tenant, records belong to users | An ownership check (`ownerId = userId`) in the query, nothing tenant-shaped |
| External consumers: mobile apps, integrations, customers' scripts | Versioned-contract discipline, `Deprecation`/`Sunset`/`Link` when a published contract changes, OpenAPI, CHANGELOG |
| The endpoint is public or abuse-prone (sign-in, sign-up, expensive work) | A rate limit (`apiConfig.rateLimit`) with `RateLimit-*` headers |
| Cookie sessions and browser clients | The CSRF origin check (already in `withApi`) and `SameSite` cookies; CORS only if the origin is cross-site |
| A retry could repeat a material side effect (money, email, provisioning, third-party calls) | `Idempotency-Key` |
| Two people can edit the same record | `ETag` and `If-Match` |
| Clients poll or cache a resource | `If-None-Match` and 304 |
| The collection can grow to thousands of rows | Cursor pagination and the index that matches its order (small, stable lists: `limit` + `offset`) |
| The endpoint calls external services | `fetchWithTimeout`, a controlled 503, and the SSRF rules when the URL comes from a client |
| The project already has service or repository layers | Follow them; add layers only when the project has none and the logic warrants it |

### Two profiles

- **Minimal** (start here): `withApi` → `requireAuth` → Zod parse → the project's own data access → DTO →
  response. Files: `route.ts`, `[id]/route.ts`, `contract.ts` and a test. No `model`, `service` or `repository`
  layers, no tenant concept unless the app is multi-tenant, and only the helpers the endpoint uses. The skeleton is
  in `references/patterns.md`, section "Minimal profile".
- **Full**: the repository/service layering, tenant scoping, cursor pagination, idempotency, ETag and the rest of
  this file. Use it when multi-tenancy, external consumers, retries, concurrency or volume are real requirements,
  or when the project already uses those layers. The scaffold generates only this profile.

Moving from minimal to full is a decision, not a default.

### How to ask

When a decision needs the user, ask one short question with two or three options and your recommendation first,
for example: "Isolate data per workspace? 1. No, one tenant with ownership checks (recommended: your schema has no
workspace table) 2. Yes, multi-tenant". If you cannot ask (non-interactive run), take the simplest safe option and
list it under *Omitted on purpose* in the reply.

## Directory architecture

The route tree is fixed: every HTTP endpoint is a Route Handler under `src/app/api/v{major}/`, and there is never
an unversioned `/api/...` path for a public contract. Each version keeps its own contract next to its routes.

```
src/app/api/v1/<resource>/route.ts                  # GET list, POST create
src/app/api/v1/<resource>/[id]/route.ts             # GET one, PATCH, PUT (rarely), DELETE
src/app/api/v1/<resource>/[id]/<command>/route.ts   # domain command, e.g. complete, sync
src/app/api/v1/<resource>/contract.ts               # this version's Zod schemas + DTO mapper
src/app/api/v2/...                                  # a breaking change = a new tree with its own contracts
```

Resource folders are plural, lowercase, kebab-case (`meal-plans`). Outside that tree, follow the project's own
conventions; if it has none, use these defaults: `src/config/api.ts` for settings, `src/lib/api/` for shared HTTP
helpers and, in the full profile, `src/server/<resource>/` for the version-agnostic `model.ts`, `service.ts` and
`repository.ts`. Docs, when the context asks for them: `docs/api/openapi.v1.json` (generated) and
`docs/api/CHANGELOG.md`.

## Configuration

Limits and settings live in one place, `src/config/api.ts` (`apiConfig`): page sizes, body size, rate-limit
policies, handler and outbound timeouts, retries, idempotency TTL, allowed browser origins, security and cache
headers. Each value has a safe default and can be overridden by an `API_*` environment variable that Zod validates
when the module loads, so a bad value stops the app at startup instead of misbehaving later.

- Never hard-code a limit in a handler, service or helper: read `apiConfig`. A new setting goes in that file with
  a default, bounds, and a comment saying why the value is what it is.
- If the project already has a settings module, add an API section there instead of a second file. In the minimal
  profile, delete the groups the endpoint doesn't use.
- Server-only: never import it from client code, never expose these variables as `NEXT_PUBLIC_*`.
- One exception: `export const maxDuration = 30` in each `route.ts` must be a literal (Next.js analyzes it
  statically). Keep it above `apiConfig.timeouts.handlerMs`, so `withApi` answers a controlled 503 first.

## Quick path

Decide the profile first (*Complexity budget*), then install only what it needs. The scripts never overwrite
existing files. If there is no project on disk, use the output folder as `<root>`.

```
node <skill-dir>/scripts/install-helpers.mjs <root> --profile minimal   # HTTP basics only
node <skill-dir>/scripts/install-helpers.mjs <root> --profile full      # adds idempotency, rate limit, ETag, deprecation, outbound
node <skill-dir>/scripts/scaffold-resource.mjs <root> --name <kebab-plural> [--version 1]   # full profile only
```

- **Skip the install** when the project already has equivalents (an error helper, a logger, an auth function):
  reuse them instead of adding a second set, and close the gaps in what exists rather than around it: an
  `x-request-id` header on every response, no database or provider text in 5xx bodies (*patterns*, "Adapting an
  existing error helper"), the origin check in `proxy.ts` when there is no `withApi` (*patterns*, "CSRF"),
  `Deprecation` and `Link` on a legacy duplicate. Follow the project's test helpers and mocks for the tests.
- **Minimal:** write `contract.ts` and the routes by hand from the skeleton, calling the project's data access, and
  implement `lib/api/principal.ts` with the project's authentication.
- **Full:** the scaffold creates routes, contract, model, service, repository interface, an in-memory repository
  and passing contract tests for a sample resource. Then edit the fields in `model.ts` and `contract.ts`, write the
  rules in `service.ts`, implement `createXRepository` with the project's data layer (rules in its header),
  implement `lib/api/principal.ts`, and adapt the tests.
- Reading budget: this file is enough for most work. Open a reference only for the section you need
  (`grep -n '^## ' references/patterns.md`, then read that section), and don't open `assets/templates/`.

## Step 0: Route Handler or Server Action?

- **Route Handler** whenever anything other than this app's own UI will call it: mobile apps, third parties,
  webhooks, cron or queue callers, or the frontend fetching JSON from a stable contract. Default for "an endpoint".
- **Server Action** only for a mutation bound to this app's UI with no need for a public HTTP contract. Server
  Actions are reachable by direct POST and page-level auth checks don't cover them, so each one authenticates,
  authorizes and Zod-validates like a handler, but is never documented, shared or relied on as an API. If someone
  wants to call one from outside the UI, create a versioned Route Handler and have both call the same logic.

## Workflow for building or changing an endpoint

1. **Read the context** (*Complexity budget*): app shape, consumers, public or internal, existing conventions, real
   requirements. Choose the profile and note which recommended rules you will omit and why. Ask before
   introducing heavier architecture.
2. **Pin down the contract.** Resource, caller, who may use it (owner, role, tenant), inputs and outputs; for
   changes, is it backward compatible (same major) or breaking (see *Versioning*)?
3. **Inspect the project**: Next.js and Zod versions in `package.json` (`references/stack-notes.md` for Next 15 or
   Zod 3), existing helpers and layers, test runner, how authentication and data access are done today, and the
   project's own rules for agents (`AGENTS.md`, `CLAUDE.md`, a contributing guide): they win over these defaults
   where they are stricter or name a convention. Edit existing files in place, keeping their line endings.
4. **Install what the profile needs** (*Quick path*), or adapt what exists.
5. **Design URL and method** per *Rules digest*, then edit the contract: separate Zod schemas for path params,
   query, body and response DTO, a `toDto` mapper, and a PATCH schema written explicitly.
6. **Thin handlers**: `withApi` → `requireAuth` → parse params, query, body → logic → DTO → status and envelope.
   Type the context with Next's generated `RouteContext<'/api/v1/<resource>/[id]'>`. No business logic in `route.ts`
   beyond calling the project's data access (minimal) or the service (full).
7. **Data access**: ownership (and, if multi-tenant, tenant) in every query, atomic statements and constraints
   instead of read-then-write checks. Full profile: rules in the service, queries in the repository. If the
   change needs different stored data, write the additive migration now (*Versioning*).
8. **Document only what the context asks for**: OpenAPI from the Zod schemas (`.meta()` ids and descriptions) and a
   CHANGELOG entry for public or consumed APIs and any contract change; nothing for a purely internal endpoint.
9. **Verify, then fix until green.** In a real project run `npx next typegen`, `npx tsc --noEmit` and the tests; fix
   every error. If you can't run them (no project or dependencies on disk), say so plainly in your reply and list
   the exact commands.
10. **Self-review** against the *Definition of done*, and prepare the *Final response*.

If the user asks for something that breaks the policy ("return the whole table", "add `/api/users` without a
version", "return 200 with `ok: false`"), build the compliant version and explain in a sentence which rule applies
and why. If they insist, do it, marking the deviation in a code comment and in your reply.

## Rules digest

Everything here applies in full when the context calls for it (*What the context turns on*). The baseline in the
*Complexity budget* is always on.

### Resources and URLs

- Plural, lowercase, kebab-case: `/api/v1/meal-plans`, `/api/v1/meal-plans/{id}`, with stable opaque public ids
  (UUID or prefixed), never serial integers or other storage internals.
- CRUD: `GET` list, `GET {id}`, `POST` create, `PATCH {id}` partial update, `PUT {id}` only for intentional full
  replacement, `DELETE {id}`.
- Filters, sort, field selection and pagination are query params (`?status=active`), never extra paths (`/active`).
- Action endpoints (`POST /meal-plans/{id}/complete`) only for domain commands with side effects or orchestration.
  A plain field change is `PATCH` (`{ "owner_id": "..." }`, not `/assign-owner`).
- One canonical path per behavior; a legacy duplicate gets deprecation headers and a named successor.
- JSON in, JSON out. Body with a non-JSON `Content-Type` → `415`; an `Accept` that excludes JSON → `406`.

### Status codes

| Situation | Status |
|---|---|
| Read or update with body | 200 |
| Created (add `Location: /api/v1/<resource>/{id}`) | 201 |
| Success with no body (typical `DELETE`) | 204 |
| `If-None-Match` matches the current `ETag` on a GET | 304 (no body) |
| Malformed JSON, invalid path or query params | 400 |
| Missing or invalid authentication | 401 |
| Authenticated but not allowed; cookie mutation from a foreign origin (`CSRF_REJECTED`) | 403 |
| Not found **or not visible to this user or tenant** | 404 |
| State or uniqueness conflict (incl. idempotency key in flight) | 409 |
| `If-Match` doesn't match the current `ETag` | 412 |
| Body too large | 413 |
| Unsupported `Content-Type` | 415 |
| Well-formed body that fails schema or business validation; idempotency key reused with another payload | 422 |
| Conditional request required but `If-Match` missing | 428 |
| Rate limited (add `Retry-After`) | 429 |
| Unexpected server error | 500 |
| Dependency down, or the handler exceeded its deadline (`TIMEOUT`); add `Retry-After` | 503 |

Use 404 rather than 403 when revealing that a resource exists would leak another user's or tenant's data. Never
return 200 with an error in the body.

### Validation and DTOs (always)

- Everything from outside is `unknown` until Zod parses it: `params`, `searchParams`, headers, cookies, bodies,
  uploads, webhook payloads and responses from external APIs. Parse at the handler boundary, before any side
  effect or data access.
- Write schemas are strict (`z.strictObject`): unknown fields are rejected, so typos surface and nobody can
  mass-assign `ownerId`, `role` or `created_by` (OWASP API3).
- Write the PATCH schema explicitly from shared field schemas; never `createSchema.partial()` when the create
  schema has `.default()`s: in Zod 4 the default still fires for an absent field, so a PATCH that omits `status`
  would silently reset it.
- Never pass the request body, or a spread of it, to the data layer. Build the insert or update object field by
  field from parsed input plus server-derived values (owner, and tenant if any, from the principal, never from the
  request).
- Responses go through an explicit `toDto(row)` that allowlists fields and renames internal columns to contract
  names; the data access returns only the columns the DTO needs.

### Envelopes and errors (always)

- One resource: `{ "data": { ... } }`. Collection: `{ "data": [...], "meta": {...}, "links": {...} }`. One shape
  per endpoint family; no bare arrays, no raw rows.
- Errors always `{ "error": { "code", "message", "details"?, "request_id" } }`. `code` is a stable UPPER_SNAKE
  machine code (`VALIDATION_FAILED`, `NOT_FOUND`, `REFUND_NOT_PENDING`); `message` is safe and actionable;
  `details` holds field-level issues. No stack traces, SQL, driver or provider text, tokens or secrets: log those
  server-side with the request id.

### Pagination and filtering

- Always: every collection has a deterministic order ending in a unique tie-breaker (`created_at desc, id desc`)
  and a bounded `limit` (sizes from `apiConfig.pagination`, validated, rejected rather than silently clamped).
- Small, stable lists (per-user, admin screens): `limit` + `offset`, with `meta` `{ limit, offset, has_more }` and
  `links.next` built from the next offset.
- Collections that can grow to thousands of rows or change under the reader: opaque cursor (keyset) pagination, with
  `meta` `{ limit, has_more, next_cursor }` and `links` `self`/`next` (null at the end); every list order is backed
  by a composite index that matches it column for column and direction for direction: `([tenant], [equality
  filters], sort column, tie-breaker)`, partial on "not deleted" with soft delete. Ship the index in the same
  change as the endpoint, or the cursor degrades into a scan as the table grows.
- Filters and sort come from Zod enums. Never interpolate a client-provided column name, operator or query
  fragment. A decoded cursor is validated strictly (ISO datetime, UUID) and only ever passed as bound parameters.
- Avoid N+1: fetch related data with joins or one batched query, and bound every embedded list.

### Concurrency and idempotency (only with a concrete need)

- `GET`, `HEAD`, `PUT`, `DELETE` are naturally retry-safe; keep them so.
- A `POST` that charges, refunds, sends, provisions or calls a third party must accept `Idempotency-Key`:
  `withIdempotency` stores key and payload hash per scope, replays the first response, answers 409 while it is in
  flight and 422 when the key is reused with another payload (*patterns*, "Idempotency"). Creating a plain record
  with no external side effect doesn't need it.
- When two people can edit the same record, return an `ETag` (from a `version` column) and require `If-Match` on
  `PATCH` and `PUT`, applied atomically in the update statement: zero rows → 412 (or 404). Never compare in
  JavaScript and then write.
- When clients poll or cache a resource, `GET {id}` honors `If-None-Match` with `notModified(req, etag)`: 304 and no
  body when the client already holds that version.

### Security

Always:

- Authenticate server-side on every protected endpoint (`requireAuth`). The principal comes from a verified
  credential and server-controlled data, never from the body, query, path or a client header. No identity → deny
  (401/403), never a default user or tenant.
- Authorization and ownership on every query: a record is returned or changed only if the caller may (the owner
  or a permitted role); admin-only operations pass `roles` (OWASP API1, API5).
- Secrets stay server-side: never in responses, URLs, logs or `NEXT_PUBLIC_*` variables. Logs redact
  `authorization`, cookies, tokens, passwords and emails. Never build queries by concatenating input (injection).
- Security headers on every response, errors included, come from `apiConfig.headers.security` via `withApi`
  (`Strict-Transport-Security`, a restrictive `Content-Security-Policy`, `Referrer-Policy`, `X-Frame-Options`,
  `Cross-Origin-Resource-Policy`, `X-Content-Type-Options`), and authenticated responses are `private, no-store`.
- Cap the body size (Route Handlers have no built-in limit; `parseJsonBody` enforces one) and never cache user data:
  no `'use cache'` on anything that reads the session or per-user rows.

Only when the trigger is true:

- **Multi-tenant:** `tenantId` comes from the principal and every query is scoped by it (OWASP API1): that is the
  first wall. The second wall lives in the database (row-level security, a schema or credentials per tenant) so
  that one forgotten `where` cannot become a leak (*patterns*, "Database-level tenant isolation"). Either add it,
  or recommend it with the exact policy, or say why the store can't have one, and put that decision in the reply;
  never leave it unsaid. Uniqueness, foreign keys and state rules are constraints.
- **Cookie sessions:** `withApi` rejects (403 `CSRF_REJECTED`) any `POST`/`PUT`/`PATCH`/`DELETE` that carries a
  cookie, no `Authorization` header, and an `Origin` (or `Sec-Fetch-Site`) that is neither this host nor in
  `API_ALLOWED_ORIGINS`. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax` or stricter. Never move a state change to
  `GET` to avoid this.
- **Cross-origin browser clients:** CORS with an explicit origin allowlist; never `*` with credentials.
- **Public, sign-in or expensive endpoints:** a rate limit on a store shared across instances, advertised with
  `RateLimit-Policy` / `RateLimit` and `Retry-After` on 429 (OWASP API4).
- **The server fetches a client-supplied URL:** the SSRF rules (*patterns*, "Outbound URLs and SSRF", API7).
- **Documented or consumed API:** every endpoint is in the versioned OpenAPI document (OWASP API9).
- Multi-write invariants run in one transaction inside one data-access function.

### Reliability and observability

- Always: `withApi` runs each handler under `apiConfig.timeouts.handlerMs` and answers 503 `TIMEOUT` with
  `Retry-After` when it is exceeded; `api.signal` aborts at the same moment, so pass it to outbound and data calls.
  Each route exports a literal `maxDuration` (seconds) above that deadline.
- Calls to external services get an explicit timeout, bounded retries only for transient failures of idempotent
  operations (`fetchWithTimeout`, budgets from the config), and map failure to a controlled 503
  `SERVICE_UNAVAILABLE`.
- Each request gets a request id (accept a sane incoming `x-request-id`, else generate one), echoed in the
  `x-request-id` header and in every error body, and logged as structured JSON with route template, method,
  status, latency and the W3C `trace_id` when a `traceparent` arrives, through `after()` so logging never delays
  the response.
- Metrics come from those logs when the project has observability: request rate, 5xx rate and latency percentiles
  per route from `api.request`, dependency failure rate from `api.dependency_attempt_failed` and
  `api.dependency_unavailable` (*patterns*, "Metrics from structured logs"). Keep the field names stable.

### Versioning and deprecation

- Always: the version is in the path, `src/app/api/v1/...`.
- **Stays in v1:** new optional request fields, new response fields, new resources, new query filters, new error
  codes for new situations. Clients must ignore unknown response fields.
- **Requires v2:** removing or renaming a field, changing a field's type or meaning, making an input required,
  changing auth or permission semantics, changing status codes or error behavior clients rely on. Don't silently
  repurpose a field: add a new field or endpoint and document the migration.
- A new major is a new `src/app/api/v2/` tree with its own contracts; the logic stays shared while behavior is
  identical. Never scatter `if (version === 2)` through a handler.
- Only when external consumers depend on the old contract: publish the successor, migration notes and a sunset
  date first; then wrap every route of the old contract with `withDeprecation` using ONE shared info object whose
  `successor` is `replaceVersion('v1', 'v2')`, so each route links to its own v2 equivalent (list → list,
  `/{id}` → `/{id}`) next to `Deprecation` and `Sunset` (*patterns*, "Introducing v2"). Don't remove the old
  contract before the sunset date unless there is a documented security or legal reason; after it, answer 410.
  Ship contract tests for both versions and a changelog or migration entry.
- **When the new contract needs different stored data** (a new column, a retyped or renamed field), ship an
  additive *expand* migration in the same change: add the new columns, backfill existing rows exactly (decimal or
  integer arithmetic, never floating point, refusing values that don't convert), keep the old column and keep old and
  new in sync, and drop nothing. The destructive step (the old column and any sync trigger) is a separate, later
  migration scheduled after the sunset date, written down now but not applied (*patterns*, "Contract changes that
  touch storage"). If the new shape can be computed from existing columns, derive it at read time with exact
  arithmetic and say so in the reply instead of adding a migration.

## Testing

Cover the cases that exist in this endpoint's context: unauthenticated (401), wrong role or not the owner (403 or
404), validation failures (400, 415, 422 with `VALIDATION_FAILED` details, unknown write fields rejected), success
shape and status (200, 201 with `Location`, 204), not found, unexpected errors (500 without leaked internals), and,
when the triggers exist, another tenant (404, absent from lists), conflicts (409, 412, 428), pagination across
pages, idempotent retry, rate limit (429) and dependency failure (503). Contract tests parse every response with the
response and error schemas so the envelope can't drift. The full-profile scaffold tests do this against the
in-memory repository; add integration tests for the real data layer on a local or explicitly provisioned test
database, with isolated fixtures, never against production (*patterns*, "Test data safety").

## Reviewing existing API code

Check against the baseline and the triggers that apply, and report:

```
## API review: <scope>
| # | Severity | Rule | Where | Problem | Fix |
|---|----------|------|-------|---------|-----|
```

**blocker**: data leak between users or tenants, missing auth or ownership check, secret exposure, mass assignment,
unbounded query, injection. **major**: wrong status semantics, missing validation, unversioned public path,
breaking change without a new major, raw rows returned, no idempotency on a retry-sensitive POST. **minor**:
naming, missing docs or headers, inconsistent envelope, and **unneeded complexity** (layers, tenancy, caching or
infrastructure the context doesn't call for: recommend removing it, never adding rules the context doesn't need).
Then offer to apply the fixes. For legacy paths that real consumers may use, decide explicitly between deleting and a
temporary deprecated shim (`withDeprecation`, successor, sunset), and say who the consumers are.

In code that grew before the policy, look first for what grep and a few file reads find (a real project had every
one of these):

- **Text from the database or a provider reaching the client:** `error.message` used as the message of a 5xx, or an
  error mapper that echoes any exception's message. The fix is one place (the error mapper plus a helper for failed
  calls), not one edit per route.
- **Privileged database functions behind a route:** a `SECURITY DEFINER` function, an admin client or a service-role
  key with no authorization inside, called from a route any signed-in user can reach. Maintenance and admin routes
  need a role check; confirm what the function does by reading its migration.
- **Dead endpoints:** a route that calls a function, table or column a later migration dropped. It can only answer
  500, so remove it with its client helpers.
- **Legacy unversioned duplicates that the app's own UI still calls:** move the callers to the versioned route
  (mind the envelope: `json.data.x`), keep the old path as a shim with `Deprecation` and `Link`, and ask the owner for
  the `Sunset` date instead of inventing one (old bundles cached by a service worker keep calling it).
- **Uploads (`multipart/form-data`):** cap count and size before reading, run every field through Zod (a raw
  `formData.get('group_id')` goes to the database unchecked), check that each referenced id belongs to the caller,
  and don't trust the declared MIME type.
- **Action endpoints for plain updates** (`/assign-group`), unbounded `select *` lists and write schemas that aren't
  strict.

## Final response

Say what you built, where, and how it was verified (step 9). Then add a short **Omitted on purpose** list: each
recommended rule you left out because the context doesn't need it, with its reason, for example "No `tenant_id`:
single-tenant app", "No Idempotency-Key: creating a note has no external side effect", "Offset pagination: a
per-user list under a few hundred rows", "No OpenAPI: internal endpoint used only by this UI". If you introduced
heavier architecture, say the user approved it. List the assumptions the user must check (fields, tables, auth).
For multi-tenant data, state the database-level isolation: what exists, what you added, or the exact policy you
recommend, or why the store can't have one. For a contract change that touches storage, state which migration
ships now (expand) and which is scheduled after the sunset (contract), or that the values are derived at read time.

## Definition of done

Always:

- [ ] Route Handlers under `src/app/api/v{major}/`, with that version's `contract.ts` beside them
- [ ] Plural kebab-case resource path, opaque ids, filters as query params, no duplicate path
- [ ] `requireAuth` on every protected route; authorization and ownership checked in the query; default deny
- [ ] Params, query and body parsed with separate Zod schemas before side effects; strict writes; explicit PATCH schema
- [ ] Persistence objects built field by field; owner (and tenant, if any) derived from the principal
- [ ] Explicit columns plus `toDto`; `{ data }` or `{ data, meta, links }`
- [ ] Errors use the standard shape with `request_id`; nothing internal leaked; no secrets in responses or logs
- [ ] Status codes per table; `Location` on 201; 415 and 406 handled
- [ ] Collections: deterministic order with tie-breaker, bounded limit
- [ ] Constraints and atomic statements instead of read-then-write; timeouts and controlled 503 on outbound calls
- [ ] No hard-coded limits: sizes, quotas, timeouts and origins come from the config; literal `maxDuration` per route
- [ ] Tests per *Testing*; `tsc` and tests run and green, or the reply says why not and how to run them
- [ ] The reply lists what was omitted on purpose and why, and the assumptions to check

When the context requires it:

- [ ] Tenant scoping in every query and cross-tenant tests (multi-tenant), plus the database-level wall added or recommended, or the reason there is none, stated in the reply
- [ ] Contract change that touches storage: additive expand migration with an exact backfill now, the destructive drop scheduled after the sunset (or read-time derivation, stated)
- [ ] Cursor pagination with a validated cursor, `links.next` and the matching composite index (large collections)
- [ ] `Idempotency-Key` on retry-sensitive POSTs; `ETag`/`If-Match` for concurrent edits; `If-None-Match` for polling clients
- [ ] CSRF check and `API_ALLOWED_ORIGINS` for cookie sessions; CORS allowlist for cross-origin clients
- [ ] Rate limit on public or abuse-prone endpoints
- [ ] OpenAPI and changelog for public or consumed APIs; per-route deprecation headers when replacing a contract
- [ ] Client-supplied URLs pass the SSRF checks; no user data under `'use cache'`

## References

| File | Use it for |
|---|---|
| `scripts/install-helpers.mjs` | `--profile minimal` copies the HTTP basics (config, `withApi`, errors, parsing, responses, pagination, logger, `requireAuth` with a user-only `principal.ts`); `--profile full` adds tenant `principal.ts`, ETag and 304, deprecation, idempotency, rate limit and `fetchWithTimeout` |
| `scripts/scaffold-resource.mjs` | Full profile only: a complete resource under `src/app/api/v{N}/<name>/` plus model, service, repository and tests |
| `references/patterns.md` | Sections: minimal profile, resolving the principal, CSRF (also without `withApi`), adapting an existing error helper, idempotency, rate limiting, CORS, invariants and transactions, database-level tenant isolation, contract changes that touch storage (expand and contract), indexes, ETag and conditional GET, domain commands, SSRF, webhooks, metrics from structured logs, OpenAPI from Zod, introducing v2 and deprecating v1, test data safety |
| `references/stack-notes.md` | Next.js 16 vs 15 and Zod 4 vs 3 differences |
| `references/api-policy.md` | The full normative policy |
