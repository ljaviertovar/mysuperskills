// src/lib/api/deprecation.ts
// Wrap every handler of a deprecated contract during its migration period. The successor link must point at the
// *equivalent* v2 URL of each route (list -> list, /{id} -> /{id}), so give it as a function of the request:
//
//   const V1_DEPRECATION = { deprecatedAt: new Date('2026-11-09'), sunsetAt: new Date('2027-05-10'),
//                            successor: replaceVersion('v1', 'v2'), docs: 'https://docs.example.com/migrate-v2' };
//   export const GET = withDeprecation(V1_DEPRECATION, withApi(ROUTE, handler));   // same info on every v1 route
//
// Headers: Deprecation (RFC 9745, @unix-seconds), Sunset (RFC 8594, HTTP-date), Link to successor and docs.
export type UrlOf = string | ((req: Request) => string);

export type DeprecationInfo = {
  deprecatedAt: Date;
  sunsetAt: Date;
  successor?: UrlOf; // rel="successor-version", e.g. replaceVersion('v1', 'v2')
  alternate?: UrlOf; // rel="alternate" when the replacement is a different resource, not a new version
  docs?: string; // migration guide URL
};

// Maps /api/v1/invoices/42?x=1 -> /api/v2/invoices/42?x=1 (path + query only, so no Host header is trusted).
export function replaceVersion(from: string, to: string): (req: Request) => string {
  return (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(new RegExp(`^/api/${from}(?=/|$)`), `/api/${to}`);
    return `${path}${url.search}`;
  };
}

const resolve = (value: UrlOf, req: Request): string => (typeof value === 'function' ? value(req) : value);

export function applyDeprecationHeaders(headers: Headers, info: DeprecationInfo, req: Request): void {
  headers.set('Deprecation', `@${Math.floor(info.deprecatedAt.getTime() / 1000)}`);
  headers.set('Sunset', info.sunsetAt.toUTCString());
  const links: string[] = [];
  if (info.successor) links.push(`<${resolve(info.successor, req)}>; rel="successor-version"`);
  if (info.alternate) links.push(`<${resolve(info.alternate, req)}>; rel="alternate"`);
  if (info.docs) links.push(`<${info.docs}>; rel="deprecation"; type="text/html"`);
  if (links.length) headers.append('Link', links.join(', '));
}

export function withDeprecation<Args extends [Request, ...unknown[]]>(
  info: DeprecationInfo,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    const response = await handler(...args);
    applyDeprecationHeaders(response.headers, info, args[0]);
    return response;
  };
}
