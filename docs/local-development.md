# Local development

## Prerequisites

- Node.js and npm
- Docker Desktop (or Docker Engine with Compose v2)
- local ports `5434` (PostgreSQL) and `3000` (NestJS) available

From `ecommerce-backend`, install dependencies and create the local environment
file. The command never creates or overwrites `.env` itself.

```powershell
npm install
Copy-Item .env.example .env
npm run dev:setup
npm run start:dev
```

On macOS or Linux, use `cp .env.example .env` instead of `Copy-Item`.

`dev:setup` starts PostgreSQL, waits for its bounded health check, creates only
the missing `ecommerce_dev` and `ecommerce_test` databases, applies pending
migrations to `ecommerce_dev`, and runs the idempotent demo seed. It is safe to
rerun and preserves existing development data.

The `DEV_DB_*` values identify the one container, host port, Compose project,
and persistent volume managed by these commands. When that exact container
already exists, `dev:db:up` reuses it; if stopped, it starts it before checking
the published port and readiness. It does not recreate the container or remove
its volume.

The backend is available at `http://localhost:3000`; Swagger UI is at
`http://localhost:3000/api/docs`. PostgreSQL is exposed on local port `5434`.

See [demo-data.md](./demo-data.md) for the deterministic demo accounts and
catalog contents.

Stop the local database safely with:

```powershell
npm run dev:db:down
```

This stops only the configured local PostgreSQL container. It does not remove
the container or its persistent volume. Restart it with `npm run dev:db:up`.

The Cloudinary, Telegram, and MoMo sections in `.env.example` are optional
provider integrations. Their committed values are local placeholders only;
`dev:setup` never calls external providers. Replace them only when intentionally
testing those integrations, and never use the example secrets in production.

## Integration tests

Integration tests are restricted to `NODE_ENV=test` and `DB_NAME=ecommerce_test`.
They refuse the development, maintenance, and template databases.

```powershell
Copy-Item .env.test.example .env.test
$env:ECOMMERCE_TEST_DB_PASSWORD = '<isolated local database password>'
npm run test:database-safety
npm run test:integration
```

The password environment variable is intentionally not committed. The test
suite runs migrations and clears data only inside `ecommerce_test`.
