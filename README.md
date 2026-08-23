# Evergreen Store backend

NestJS, PostgreSQL, and TypeORM API for the Evergreen Store customer and
administration applications.

## Local development

Requirements: Node.js, npm, Docker with Compose v2, and free local ports 3000
and 5434.

```powershell
npm install
Copy-Item .env.example .env
npm run dev:setup
npm run start:dev
```

`dev:setup` starts or reuses only the configured PostgreSQL container, creates
the allowlisted `ecommerce_dev` and `ecommerce_test` databases when missing,
runs development migrations, and applies the idempotent demo seed. It never
removes the container or its volume. See
[docs/local-development.md](./docs/local-development.md) for safety details and
demo credentials.

The API is served at `http://localhost:3000`; `GET /health` returns a minimal
hosting health response. Swagger remains available locally at `/api/docs` and
`/api/docs-json`. It is disabled by default when `NODE_ENV=production` and can
be explicitly enabled with `SWAGGER_ENABLED=true`.

## Verification

```powershell
npm run build
npx tsc --noEmit
npm test -- --runInBand
npm run test:dev-setup
npm run test:database-safety
npm run test:integration
```

Integration tests require `.env.test` and the dedicated `ecommerce_test`
database. Copy `.env.test.example` to `.env.test`, then provide
`ECOMMERCE_TEST_DB_PASSWORD` in the shell with the password of the isolated
local PostgreSQL container. Safety guards reject `postgres`, `ecommerce_dev`,
and non-test environments before destructive cleanup.

Cloudinary, Telegram, and MoMo values in `.env.example` are placeholders. Real
provider credentials are optional for local setup and must never be committed.

## Production readiness

Run `npm run migration:run:prod` before `npm run start:prod`. Production startup
requires valid `PORT`, `FRONTEND_ORIGIN`, database, and JWT configuration and
fails without printing secret values. `FRONTEND_ORIGIN` must be the exact
HTTP(S) storefront origin; wildcard CORS is not supported.

The complete Neon + Render + Vercel free deployment procedure is documented in
[docs/free-deployment.md](./docs/free-deployment.md).
