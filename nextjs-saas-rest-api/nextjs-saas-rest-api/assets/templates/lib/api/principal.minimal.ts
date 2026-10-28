// src/lib/api/principal.ts  — PROJECT-OWNED (minimal profile: users and roles, no tenant concept)
// The one place that knows how this application authenticates callers (session cookie, bearer JWT, API key...).
// Everything else (requireAuth, handlers) only sees a Principal.
//
// Implement `resolvePrincipal` with the project's existing mechanism, or reuse its helper. Contract:
//   - Verify the credential on the server: for a JWT check signature, expiry, issuer, audience and an allowlist of
//     algorithms; for a session, look it up; for an API key, compare a hash. Never just decode a token.
//   - Take the user id and role from the verified credential or server-side data, never from the request body,
//     query string, path or a client-editable header.
//   - Return null when there is no valid credential. Throw only for infrastructure failures.
// Data access then scopes every query by `userId` (ownership) and checks `role` where an operation is restricted.
// If the app later becomes multi-tenant, move to the full profile's principal.ts, which adds `tenantId`.
export type Principal = { userId: string; role: string };

export async function resolvePrincipal(_req: Request): Promise<Principal | null> {
  // Fails closed: until this is implemented every protected endpoint answers 500, never "anonymous allowed".
  throw new Error('resolvePrincipal is not implemented. Wire it to the project authentication (patterns: "Resolving the principal").');
}
