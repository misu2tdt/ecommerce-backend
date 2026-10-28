// Per-client-IP request limits for `@nestjs/throttler`. ttl is in milliseconds.
// Plain constants rather than env settings: nothing needs tuning per environment.

// Generous default for every route that does not opt out or override it.
export const GLOBAL_THROTTLE = { ttl: 60_000, limit: 100 };

// Strict limit for credential endpoints, to slow down password guessing and
// account-creation spam.
export const AUTH_THROTTLE = { ttl: 60_000, limit: 10 };
