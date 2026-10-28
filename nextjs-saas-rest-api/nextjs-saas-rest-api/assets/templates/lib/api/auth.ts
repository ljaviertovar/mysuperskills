// src/lib/api/auth.ts
// Entry point for authentication and authorization in Route Handlers. Default deny: no verified principal -> 401,
// wrong role -> 403. How a caller is identified lives in ./principal (project-owned); this file never changes
// when the authentication mechanism does.
import { ApiError } from './errors';
import { resolvePrincipal, type Principal } from './principal';

export type { Principal };

export async function requireAuth(req: Request, options: { roles?: readonly string[] } = {}): Promise<Principal> {
  // 1. Who is calling, and for which tenant? Null means no valid credential.
  const principal = await resolvePrincipal(req);
  if (!principal) {
    throw new ApiError('UNAUTHENTICATED', 'Authentication is required.', { headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  // 2. Function-level authorization (OWASP API5): check the role for this operation, not just the tenant.
  if (options.roles && !options.roles.includes(principal.role)) {
    throw new ApiError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  return principal;
}
