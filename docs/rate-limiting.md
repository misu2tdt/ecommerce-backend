# Rate limiting

Every route is rate limited with `@nestjs/throttler`. The limits live in one
file, [`src/config/throttling.ts`](../src/config/throttling.ts), as plain
constants. Tests import the same constants, so changing a number never needs a
test edit.

## Why the key matters

A limit counts requests per **key**. The first version keyed everything by client
IP. In the free deployment the browser never calls this API directly:

```text
Browser -> Vercel (Next.js, server-side fetches) -> Render (proxy/CDN) -> API
```

The API therefore sees the address of the Vercel server (as forwarded by
Render's proxy), the same for every visitor. With a per-IP key, all visitors
shared one bucket: 100 requests a minute per route, and 10 logins a minute for
everybody. The storefront header calls `GET /auth/me` on every page, so a few
visitors could use up the allowance; the header then treated the refused call as
"not signed in" and silently showed **Sign In**.

The fix is to key each request by the most specific caller that can be verified,
and to fall back to the IP only when there is nothing better.

## How a request is counted

The throttler keeps one counter per **route handler and caller**. A busy route
can therefore never use up the allowance of another route. The caller is:

| Request | Caller key | Why |
|---|---|---|
| Valid bearer token | `user:<id>` | A person has their own bucket, whatever IP they share. |
| `POST /auth/login` (extra limit) | `email:<normalised email>` | One account cannot be guessed at from many IPs, and different people do not block each other. |
| Everything else, and any token that fails verification | `ip:<address>` | Nothing better is known. |

The kinds are prefixed, so user 5, the email `user:5@x.com` and an IP can never
share a bucket. Every key is hashed by the throttler before it is stored.

What is trusted:

- **The token** is verified with the API's secret (signature and expiry), never
  just decoded. A forged, expired, tampered or foreign token is treated as
  anonymous and lands in the IP bucket. Only a token with a positive integer
  `sub` and the claims this API issues counts as a user.
- **The IP** is Express' `req.ip`. In production `trust proxy` is set to exactly
  one hop, so it is the address Render's proxy saw. Extra `X-Forwarded-For` hops
  a client adds are ignored, and no other header (such as a user id) is read.
  IPv6 addresses are grouped by subnet, so one host cannot rotate through
  addresses to dodge a limit.
- **The email** is the one in the login request body, trimmed and lower-cased
  (login looks emails up exactly, so merging spellings only ever limits more).
  Without a usable email the request is counted by IP.

## Limits and why

All windows are 60 seconds.

| Limit | Key | Value | Reason |
|---|---|---|---|
| Any route, anonymous | IP | 600 | One shared proxy IP stands for every visitor. A page view calls a given route about once, so 600 a minute is ten page views a second of the same page across the whole site, six times the old 100. |
| Any route, signed in | user | 300 | One person at five requests a second to one route is far above normal browsing, so this still stops a runaway script. Lower than the shared IP allowance on purpose. |
| `GET /auth/me` | user (or IP) | 600 | The header calls it on every page, and it only checks the token (no database). It has its own counter, so it can use up only itself: after 600 calls the same user still reaches every other route. It is limited, not exempt, so an unauthenticated flood cannot call it without bound. |
| `POST /auth/login` | email | 20 | The brake on password guessing, whatever IPs the guesses come from. Every attempt counts, successful or not. 20 leaves room for several visitors using the shared demo account in one minute. |
| `POST /auth/login` | IP | 300 | A ceiling against one source trying many emails, high enough that a shared proxy does not reach it by accident. A token in the request does not move it to another bucket. |
| `POST /users/register` | IP | 20 | Account creation is the expensive, abusable action. Per IP only: if a signed-in user had their own bucket, registering accounts would multiply the allowance. |
| `GET /health`, MoMo IPN webhook | none | exempt | Platform probes and payment callbacks must never be refused. |

A refused request gets `429 Too Many Requests` with `Retry-After` and
`X-RateLimit-*` headers.

## Known limits of this design

- **Login lock-out.** Anyone who knows an email can use its 20 attempts a minute
  and so block that account's logins until the minute ends. This includes the
  shared demo customer. Counting only failed attempts, or an increasing lock-out,
  would avoid it but is not supported by the throttler.
- **The shared IP ceilings.** While the API only sees one proxy address, a
  caller who goes through the storefront can use up the login IP ceiling (300) or
  the register allowance (20) for everybody for a minute. Per-email and per-user
  keys cannot help for requests that have neither.
- **Memory storage.** Counters live in the memory of one API process and reset
  on restart. This is enough for the single free Render instance; several
  instances would need a shared store such as Redis.

## What a deployment behind a trusted proxy would do differently

This is not implemented. The right fix for the shared IP is to give the API the
real client address, from a source it can verify:

1. The storefront reads the visitor's address at the edge (Vercel provides it
   to server code).
2. It sends it to the API in a header together with a signature (an HMAC of the
   address and a timestamp, using a secret known only to the storefront and the
   API), or over a private network so the header cannot come from anyone else.
3. The API uses the address only when the signature checks out, and otherwise
   falls back to `req.ip`. A client-supplied address without that proof is never
   trusted.

With that in place the IP limits could be tightened to per-person values, and
the shared-IP caveats above would no longer apply.
