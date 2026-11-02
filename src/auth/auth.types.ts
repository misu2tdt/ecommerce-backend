import { UserRole } from '../users/entities/user-role.enum';

export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
}

export interface AuthenticatedUser {
  id: number;
  email: string;
  role: UserRole;
}

// Whether a verified token payload carries the claims this API issues.
export function isJwtPayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & JwtPayload {
  return (
    typeof payload.sub === 'number' &&
    Number.isInteger(payload.sub) &&
    payload.sub > 0 &&
    typeof payload.email === 'string' &&
    payload.email.length > 0 &&
    (payload.role === UserRole.USER || payload.role === UserRole.ADMIN)
  );
}
