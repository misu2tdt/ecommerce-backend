import type { IncomingHttpHeaders } from 'node:http';

// The token of an `Authorization: Bearer <token>` header, if there is one.
// Shared by the auth guard and the rate limiter so both read it the same way.
export function extractBearerToken(
  headers: Pick<IncomingHttpHeaders, 'authorization'>,
): string | undefined {
  const [type, token] = headers.authorization?.split(' ') ?? [];
  return type === 'Bearer' ? token : undefined;
}
