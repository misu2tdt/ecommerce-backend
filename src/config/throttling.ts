// Request limits for `@nestjs/throttler`. ttl is in milliseconds.
// Plain constants rather than env settings: nothing needs tuning per environment.
//
// Every limit is per route handler AND per caller: the throttler keeps one
// counter for each (handler, caller) pair, so a busy route can never use up the
// allowance of another. A caller is whoever the request can be pinned on:
//   - a signed-in user (a verified token): `user:<id>`
//   - a login email: `email:<normalised email>`
//   - otherwise the client IP: `ip:<address>`
// On the public demo every visitor reaches this API through the frontend's
// server, so the IP is one shared proxy address. That is why IP limits are
// generous and why people are told apart by token or email wherever possible.
// See docs/rate-limiting.md for the reasoning behind each number.

import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { normalizeIp, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { IncomingHttpHeaders } from 'node:http';
import { isJwtPayload } from '../auth/auth.types';
import { extractBearerToken } from '../auth/bearer-token';

const MINUTE = 60_000;

// Default for every route: anonymous callers share one bucket per client IP.
export const ANONYMOUS_THROTTLE = { ttl: MINUTE, limit: 600 };

// Default for every route: a signed-in user's own bucket. One person at five
// requests a second to the same route is already far beyond normal browsing.
export const USER_THROTTLE = { ttl: MINUTE, limit: 300 };

// GET /auth/me: the storefront header asks it on every page of a signed-in
// visitor. It only checks the token (no database), so it is cheap and allowed
// more than other routes. Its own counter means it cannot use up another route.
export const ME_THROTTLE = { ttl: MINUTE, limit: 600 };

// POST /auth/login, per normalised email: the real brake on password guessing,
// whatever IPs the guesses come from. Counts every attempt, successful or not.
export const LOGIN_EMAIL_THROTTLE = { ttl: MINUTE, limit: 20 };

// POST /auth/login, per client IP: only a ceiling against one source trying many
// emails, high enough for a shared proxy.
export const LOGIN_IP_THROTTLE = { ttl: MINUTE, limit: 300 };

// POST /users/register, per client IP (a signed-in user gets no separate
// bucket, or registering accounts would multiply the allowance).
export const REGISTER_THROTTLE = { ttl: MINUTE, limit: 20 };

// The extra, email-keyed throttler that only POST /auth/login opts into.
export const LOGIN_EMAIL_THROTTLER = 'login-email';
const THROTTLE_BY_EMAIL = 'throttle-by-email';
export const ThrottleByEmail = () => SetMetadata(THROTTLE_BY_EMAIL, true);

const MAX_EMAIL_LENGTH = 254;

// What the trackers read from a request. `ip` is Express' `req.ip`, which is the
// proxy-aware address (`trust proxy` is set to one hop in production).
export interface ThrottleRequest {
  ip?: string;
  headers: IncomingHttpHeaders;
  body?: unknown;
}

export type ThrottleCaller =
  | { kind: 'user'; userId: number }
  | { kind: 'anonymous'; ip: string | undefined };

// Prefixes keep the three kinds apart: the email "user:5@x.com" and user 5 can
// never end up in the same bucket.
export const userTracker = (userId: number): string => `user:${userId}`;
export const emailTracker = (email: string): string => `email:${email}`;
export const ipTracker = (ip: string | undefined): string =>
  `ip:${ip ? normalizeIp(ip) : 'unknown'}`;

// Spelling variants of one address share a bucket. Login looks the email up
// exactly, so merging case variants only ever limits more, never less.
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH ? email : null;
}

export type TokenVerifier = (token: string) => unknown;

// Tells a signed-in user from an anonymous caller. The token is verified (its
// signature and expiry), never merely decoded, so a made-up token can only ever
// land in the IP bucket. Each request is looked at once.
export function createCallerResolver(verify: TokenVerifier) {
  const known = new WeakMap<object, ThrottleCaller>();

  function identify(request: ThrottleRequest): ThrottleCaller {
    const token = extractBearerToken(request.headers);
    if (token) {
      try {
        const payload = verify(token);
        if (isRecord(payload) && isJwtPayload(payload)) {
          return { kind: 'user', userId: payload.sub };
        }
      } catch {
        // Invalid, expired or foreign token: treated as anonymous.
      }
    }
    return { kind: 'anonymous', ip: request.ip };
  }

  function resolve(request: ThrottleRequest): ThrottleCaller {
    let caller = known.get(request);
    if (!caller) {
      caller = identify(request);
      known.set(request, caller);
    }
    return caller;
  }

  function tracker(request: ThrottleRequest): string {
    const caller = resolve(request);
    return caller.kind === 'user'
      ? userTracker(caller.userId)
      : ipTracker(caller.ip);
  }

  return { resolve, tracker };
}

// For routes anyone can call and that an account must not widen: the token is
// ignored, so signing in does not buy a second bucket.
export const ipOnlyTracker = (request: ThrottleRequest): string =>
  ipTracker(request.ip);

// For login: the email being tried. Without a usable email (a malformed body,
// which the validation pipe rejects later) the request falls back to its IP.
export function emailRequestTracker(request: ThrottleRequest): string {
  const body: unknown = request.body;
  const email = normaliseEmail(
    typeof body === 'object' && body !== null
      ? (body as { email?: unknown }).email
      : undefined,
  );
  return email ? emailTracker(email) : ipTracker(request.ip);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The module's options. `verify` checks a bearer token with the API's secret.
export function createThrottlerOptions(
  verify: TokenVerifier,
): ThrottlerModuleOptions {
  const resolver = createCallerResolver(verify);
  const reflector = new Reflector();
  const requestOf = (context: ExecutionContext) =>
    context.switchToHttp().getRequest<ThrottleRequest>();

  return {
    throttlers: [
      {
        name: 'default',
        ttl: MINUTE,
        // Signed-in users and anonymous callers are counted in different
        // buckets and measured against different allowances.
        limit: (context) =>
          resolver.resolve(requestOf(context)).kind === 'user'
            ? USER_THROTTLE.limit
            : ANONYMOUS_THROTTLE.limit,
        getTracker: (request) => resolver.tracker(request as ThrottleRequest),
      },
      {
        name: LOGIN_EMAIL_THROTTLER,
        ttl: LOGIN_EMAIL_THROTTLE.ttl,
        limit: LOGIN_EMAIL_THROTTLE.limit,
        getTracker: (request) =>
          emailRequestTracker(request as ThrottleRequest),
        // Only routes marked with @ThrottleByEmail() are counted by email.
        skipIf: (context) =>
          !reflector.getAllAndOverride<boolean | undefined>(THROTTLE_BY_EMAIL, [
            context.getHandler(),
            context.getClass(),
          ]),
      },
    ],
  };
}
