# Free deployment: Neon + Render + Vercel

This guide packages the portfolio deployment without creating cloud resources or
storing credentials in either repository.

## Topology and trust boundaries

The browser talks to the Vercel-hosted Next.js application. Next.js Server
Components and Server Actions call the Render-hosted NestJS API. NestJS owns
domain validation and connects to Neon. The JWT remains only in an HttpOnly
cookie owned by the Vercel hostname; Next.js forwards it to Render as a Bearer
token on server-to-server requests.

## A. Create Neon

1. Create a Neon project, branch, role, and database in a region close to the
   Render service.
2. Copy a **direct**, non-pooled PostgreSQL connection URL. Direct connections
   are preferred for TypeORM migrations. Keep Neon-provided TLS parameters in
   the URL.
3. Store the URL as `DATABASE_URL` in Render and only in the trusted shell used
   to run migrations. Do not put it in Vercel or a committed environment file.

`DATABASE_URL` takes precedence over the local split `DB_HOST`, `DB_PORT`,
`DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME` configuration. Managed URL
connections use TLS with certificate verification. Local split configuration
continues without TLS.

## B. Configure Render

The repository `render.yaml` defines a free Node web service with:

- Node `22.22.0`
- build command `npm ci --include=dev && npm run build`
- start command `npm run start:prod`
- health check `/health`
- automatic deploys disabled so migrations remain deliberate

Set these Render environment variable names:

- Required core: `DATABASE_URL`, `FRONTEND_ORIGIN`, `JWT_SECRET`,
  `JWT_EXPIRES_IN`, `NODE_ENV`, `PAYMENT_CURRENCY`, `SWAGGER_ENABLED`
- MoMo bootstrap: `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`, `MOMO_SECRET_KEY`,
  `MOMO_IDENTITY_SECRET`, `MOMO_ENDPOINT`, `MOMO_REDIRECT_URL`, `MOMO_IPN_URL`
- Optional Cloudinary: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
  `CLOUDINARY_API_SECRET`
- Optional Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Render supplies `PORT`. The API binds it on `0.0.0.0`. `FRONTEND_ORIGIN` must
be the exact canonical Vercel HTTPS origin with no path or wildcard.

The Blueprint uses non-merchant MoMo placeholders so the application can boot.
Payment creation will fail honestly until legitimate merchant values and
callback URLs are configured.

## C. Run migrations deliberately

Render's pre-deploy command is not available on a free web service. Do not put
migrations in application startup or seed in the build command.

For the first deployment and every release containing migrations:

1. Check out the exact backend revision being deployed in a trusted local or CI
   environment.
2. Set `NODE_ENV` and `DATABASE_URL` for the target Neon database.
3. Run `npm ci --include=dev`, `npm run build`, then `npm run migration:show` if using the
   TypeScript datasource locally.
4. Run `npm run migration:run:prod` once.
5. Confirm the migration command succeeds before triggering the matching manual
   Render deploy.

TypeORM's migrations table makes already-applied migrations idempotent, but only
one operator should run migrations for a deployment. `synchronize`,
`dropSchema`, and automatic `migrationsRun` remain disabled.

## D. Optional one-time portfolio demo seed

The normal development seed remains restricted to `ecommerce_dev`. The test seed
remains restricted to `ecommerce_test`. Neither runs on deploy.

After migrations, an operator may run `npm run seed:demo:production` once from
the compiled trusted backend checkout. It requires all of:

- `NODE_ENV`
- `DATABASE_URL`
- `PRODUCTION_DEMO_SEED_CONFIRM`
- `PRODUCTION_DEMO_SEED_DATABASE`

Set `PRODUCTION_DEMO_SEED_CONFIRM=SEED_PORTFOLIO_DEMO` and set
`PRODUCTION_DEMO_SEED_DATABASE` to the exact database name resolved from
`DATABASE_URL`. Reserved databases are refused. The seed uses deterministic
upserts inside a transaction, does not truncate tables, and is safe to rerun
deliberately. Never add this command to Render build or startup.

The production portfolio seed creates the demo customer required by its saved
address, order, and review, but deliberately skips the development demo ADMIN.
The deterministic credentials in `docs/demo-data.md` are local-only and must
never be reused for a public deployment.

Provision a production ADMIN separately and explicitly:

1. Generate a unique strong password in a password manager and register a new
   account through the deployed HTTPS application. Do not use either demo email.
2. In Neon's trusted SQL console, promote only that exact account with a
   carefully verified statement:

   ```sql
   UPDATE users
   SET role = 'admin'
   WHERE email = '<operator-controlled-email>' AND role = 'user'
   RETURNING id, email, role;
   ```

3. Confirm exactly one intended row changed, then sign out and back in so the
   newly issued JWT contains the backend-confirmed ADMIN role.

The strong password is accepted and hashed by the existing registration flow;
it must never be placed in SQL, deployment variables, shell history, logs, or
Git. There is intentionally no default production admin or admin-bootstrap
command.

## E. Configure Cloudinary

Cloudinary configuration is backend-only. If all three Cloudinary variables are
absent, storefront reads and application startup remain available while image
mutations return an honest unavailable error. Partial configuration fails
startup so a mistyped secret cannot look enabled. Never define Cloudinary keys
in Vercel.

## F. Deploy Vercel

Import the independent frontend repository as a Next.js project. Set only
`NEXT_PUBLIC_API_BASE_URL` to the canonical Render HTTPS origin for Production.
It is public configuration and is frozen into each frontend build. Do not put
JWT, database, Cloudinary, or MoMo secrets in Vercel.

After Vercel assigns the final canonical production hostname, update
`FRONTEND_ORIGIN` on Render and manually redeploy the backend. Preview Vercel
origins are not accepted by the single exact production CORS allowlist.

## G. Authentication and CORS

The session cookie stays host-only on Vercel with `HttpOnly`, `Secure` in
production, `SameSite=Lax`, and path `/`. No cookie domain points to Render.
The browser submits Server Actions to the same Vercel origin, so cross-site
cookie delivery is unnecessary. Render accepts only the exact configured
frontend origin; wildcard CORS is not supported.

## H. Provider callbacks

Real MoMo activation requires legitimate merchant credentials. Set
`MOMO_REDIRECT_URL` to the deployed Vercel `/payment-return` URL and
`MOMO_IPN_URL` to the public Render `/payments/webhooks/momo` URL. The IPN URL
must remain public HTTPS because verified IPN state, not browser redirect query
parameters, is authoritative.

## I. Smoke checks

1. Request the Render `/health` endpoint and expect a 200 JSON response.
2. Confirm production Swagger routes return 404.
3. Open the Vercel catalog and a product page.
4. Verify logged-out protected redirects, customer login, customer ADMIN denial,
   and ADMIN login.
5. Confirm cookies contain no browser-readable JWT and browser storage contains
   no credentials.
6. If providers are disabled, confirm payment/image operations fail honestly
   without breaking catalog reads.

Free Render services can cold-start after inactivity, so an initial request may
take longer. Use platform logs and `/health`; no external observability service
is required for this first portfolio deployment.

## J. Rollback basics

- Application-only regression: use Render's recent-deploy rollback and Vercel's
  deployment rollback.
- Additive migration regression: roll back application code only if the older
  code remains compatible with the new schema.
- Schema rollback: inspect the migration first, take a Neon branch/restore point
  when available, and run `migration:revert` only as a deliberate operator
  action. Never automate destructive rollback.
- Rotate any credential that appears in logs or source and redeploy both affected
  services.
