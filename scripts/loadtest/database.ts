// Database side of the check: the rows it creates (customers, one category,
// one product, variants), the queries that verify results, the stock sampler
// and the clean-up. Everything the check creates carries the run marker, so it
// can be found and removed again without touching the seeded demo data.

import { DataSource, type EntityManager } from 'typeorm';
import type { LoadTestDatabaseConfig } from './guard';
import { sleep } from './http';

// Markers. Lower case for emails and slugs, upper case for SKUs. No "_" or "%",
// which are wildcards in LIKE.
export const EMAIL_MARKER = 'loadtest-';
export const EMAIL_DOMAIN = '@loadtest.invalid';
export const SKU_MARKER = 'LOADTEST-';
export const SLUG_MARKER = 'loadtest-';

// Not a bcrypt hash, so no password can ever match it: these accounts can not log in.
const UNUSABLE_PASSWORD = '!loadtest-account-cannot-log-in';
const VARIANT_PRICE = 100_000;

export function createDataSource(config: LoadTestDatabaseConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    synchronize: false,
    dropSchema: false,
    extra: { max: 5 },
  });
}

type Queryable = Pick<DataSource, 'query'> | Pick<EntityManager, 'query'>;

/** A typed query: rows come back as plain objects. */
export async function rows<T>(
  source: Queryable,
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  return await source.query(sql, parameters);
}

export async function one<T>(
  source: Queryable,
  sql: string,
  parameters: unknown[] = [],
): Promise<T> {
  const result = await rows<T>(source, sql, parameters);
  if (result.length !== 1) {
    throw new Error(`Expected one row, got ${result.length}: ${sql}`);
  }
  return result[0];
}

export interface RunMarkers {
  runId: string;
  emailPattern: string;
  skuPattern: string;
  slugPattern: string;
}

export function markersForRun(runId: string): RunMarkers {
  return {
    runId,
    emailPattern: `${EMAIL_MARKER}${runId}-%${EMAIL_DOMAIN}`,
    skuPattern: `${SKU_MARKER}${runId}-%`,
    slugPattern: `${SLUG_MARKER}${runId}%`,
  };
}

/** Every row any run of this check could have left behind. */
export function markersForLeftovers(): RunMarkers {
  return {
    runId: '*',
    emailPattern: `${EMAIL_MARKER}%${EMAIL_DOMAIN}`,
    skuPattern: `${SKU_MARKER}%`,
    slugPattern: `${SLUG_MARKER}%`,
  };
}

export interface Customer {
  id: number;
  email: string;
  addressId: number;
  token: string;
}

export interface Fixtures {
  /** Creates the category and product the variants belong to. */
  ensureProduct(): Promise<number>;
  createVariant(label: string, stock: number): Promise<number>;
  createCustomers(
    tag: string,
    count: number,
    sign: (user: { id: number; email: string }) => Promise<string>,
  ): Promise<Customer[]>;
}

export function createFixtures(ds: DataSource, runId: string): Fixtures {
  let productId: number | null = null;

  async function ensureProduct(): Promise<number> {
    if (productId !== null) return productId;
    const category = await one<{ id: number }>(
      ds,
      `INSERT INTO "categories" ("name", "slug") VALUES ($1, $2) RETURNING "id"`,
      [`Load test ${runId}`, `${SLUG_MARKER}${runId}-category`],
    );
    const product = await one<{ id: number }>(
      ds,
      `INSERT INTO "products" ("name", "slug", "categoryId") VALUES ($1, $2, $3) RETURNING "id"`,
      [
        `Load test product ${runId}`,
        `${SLUG_MARKER}${runId}-product`,
        category.id,
      ],
    );
    productId = product.id;
    return productId;
  }

  return {
    ensureProduct,

    async createVariant(label, stock) {
      const product = await ensureProduct();
      const variant = await one<{ id: number }>(
        ds,
        `INSERT INTO "product_variants" ("productId", "sku", "name", "price", "stock", "attributes", "isActive", "position")
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, true, 0) RETURNING "id"`,
        [
          product,
          `${SKU_MARKER}${runId}-${label}`,
          `Load test ${label}`,
          VARIANT_PRICE,
          stock,
        ],
      );
      return variant.id;
    },

    async createCustomers(tag, count, sign) {
      const emails = Array.from(
        { length: count },
        (_, index) => `${EMAIL_MARKER}${runId}-${tag}-${index}${EMAIL_DOMAIN}`,
      );
      const users = await rows<{ id: number; email: string }>(
        ds,
        `INSERT INTO "users" ("email", "password")
         SELECT email, $2::varchar FROM unnest($1::text[]) AS email
         RETURNING "id", "email"`,
        [emails, UNUSABLE_PASSWORD],
      );
      const addresses = await rows<{ id: number; userId: number }>(
        ds,
        `INSERT INTO "addresses" ("userId", "recipientName", "phone", "addressLine1", "city", "countryCode", "isDefault")
         SELECT id, 'Load test', '0900000000', '1 Test Street', 'Test City', 'VN', false
         FROM unnest($1::int[]) AS id
         RETURNING "id", "userId"`,
        [users.map((user) => user.id)],
      );
      const addressByUser = new Map(
        addresses.map((address) => [address.userId, address.id]),
      );
      const ordered = [...users].sort((a, b) => a.id - b.id);
      return Promise.all(
        ordered.map(async (user) => ({
          id: user.id,
          email: user.email,
          addressId: addressByUser.get(user.id) as number,
          token: await sign(user),
        })),
      );
    },
  };
}

// Queries the scenarios use to check results.

export async function variantStock(
  ds: DataSource,
  variantId: number,
): Promise<number> {
  const row = await one<{ stock: number }>(
    ds,
    `SELECT "stock" FROM "product_variants" WHERE "id" = $1`,
    [variantId],
  );
  return row.stock;
}

/** Orders and total ordered quantity for one variant. */
export async function orderedForVariant(
  ds: DataSource,
  variantId: number,
): Promise<{ orders: number; quantity: number }> {
  return one<{ orders: number; quantity: number }>(
    ds,
    `SELECT count(DISTINCT "orderId")::int AS "orders", coalesce(sum("quantity"), 0)::int AS "quantity"
     FROM "order_items" WHERE "variantId" = $1`,
    [variantId],
  );
}

export async function postgresDeadlockCount(ds: DataSource): Promise<number> {
  const row = await one<{ deadlocks: number }>(
    ds,
    `SELECT deadlocks::int AS "deadlocks" FROM pg_stat_database WHERE datname = current_database()`,
  );
  return row.deadlocks;
}

/** PostgreSQL publishes statistics a moment after the work, so wait before reading. */
export const STATISTICS_SETTLE_MS = 2000;

export async function settledDeadlockCount(ds: DataSource): Promise<number> {
  await sleep(STATISTICS_SETTLE_MS);
  return postgresDeadlockCount(ds);
}

export interface StockSamples {
  samples: number;
  failures: number;
  minimum: Map<number, number>;
}

export interface StockSampler {
  stop(): Promise<StockSamples>;
}

/** Reads the stock of the given variants over and over while a burst runs. */
export function startStockSampler(
  ds: DataSource,
  variantIds: number[],
  intervalMs = 15,
): StockSampler {
  let running = true;
  const result: StockSamples = {
    samples: 0,
    failures: 0,
    minimum: new Map(),
  };
  const loop = (async () => {
    while (running) {
      try {
        const found = await rows<{ id: number; stock: number }>(
          ds,
          `SELECT "id", "stock" FROM "product_variants" WHERE "id" = ANY($1::int[])`,
          [variantIds],
        );
        result.samples += 1;
        for (const row of found) {
          const seen = result.minimum.get(row.id);
          if (seen === undefined || row.stock < seen) {
            result.minimum.set(row.id, row.stock);
          }
        }
      } catch {
        result.failures += 1;
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return result;
    },
  };
}

// Seeded-data snapshot: proves the run left the demo data alone.

export interface SeededSnapshot {
  products: number;
  variants: number;
  variantStock: number;
  orders: number;
  users: number;
}

export async function seededSnapshot(
  ds: DataSource,
  markers: RunMarkers,
): Promise<SeededSnapshot> {
  return one<SeededSnapshot>(
    ds,
    `SELECT
       (SELECT count(*)::int FROM "products" WHERE "slug" NOT LIKE $3) AS "products",
       (SELECT count(*)::int FROM "product_variants" WHERE "sku" NOT LIKE $2) AS "variants",
       (SELECT coalesce(sum("stock"), 0)::int FROM "product_variants" WHERE "sku" NOT LIKE $2) AS "variantStock",
       (SELECT count(*)::int FROM "orders" WHERE "userId" NOT IN (SELECT "id" FROM "users" WHERE "email" LIKE $1)) AS "orders",
       (SELECT count(*)::int FROM "users" WHERE "email" NOT LIKE $1) AS "users"`,
    [markers.emailPattern, markers.skuPattern, markers.slugPattern],
  );
}

export function sameSnapshot(a: SeededSnapshot, b: SeededSnapshot): boolean {
  return (
    a.products === b.products &&
    a.variants === b.variants &&
    a.variantStock === b.variantStock &&
    a.orders === b.orders &&
    a.users === b.users
  );
}

export interface CleanupResult {
  ok: boolean;
  removed: Record<string, number>;
  problems: string[];
}

async function removeRows(
  manager: EntityManager,
  label: string,
  deleteSql: string,
  parameters: unknown[],
  removed: Record<string, number>,
): Promise<void> {
  const result = await one<{ count: number }>(
    manager,
    `WITH removed AS (${deleteSql} RETURNING 1) SELECT count(*)::int AS "count" FROM removed`,
    parameters,
  );
  removed[label] = result.count;
}

/**
 * Deletes everything that carries the markers, in dependency order, in one
 * transaction (all or nothing). Only rows of marked customers and marked
 * catalogue rows are touched.
 */
export async function cleanup(
  ds: DataSource,
  markers: RunMarkers,
): Promise<CleanupResult> {
  const removed: Record<string, number> = {};
  try {
    await ds.transaction(async (manager) => {
      const users = (
        await rows<{ id: number }>(
          manager,
          `SELECT "id" FROM "users" WHERE "email" LIKE $1`,
          [markers.emailPattern],
        )
      ).map((user) => user.id);
      const orders = (
        await rows<{ id: number }>(
          manager,
          `SELECT "id" FROM "orders" WHERE "userId" = ANY($1::int[])`,
          [users],
        )
      ).map((order) => order.id);

      await removeRows(
        manager,
        'payment events',
        `DELETE FROM "payment_events" WHERE "paymentId" IN (SELECT "id" FROM "payments" WHERE "orderId" = ANY($1::int[]))`,
        [orders],
        removed,
      );
      await removeRows(
        manager,
        'payments',
        `DELETE FROM "payments" WHERE "orderId" = ANY($1::int[])`,
        [orders],
        removed,
      );
      await removeRows(
        manager,
        'order items',
        `DELETE FROM "order_items" WHERE "orderId" = ANY($1::int[])`,
        [orders],
        removed,
      );
      await removeRows(
        manager,
        'orders',
        `DELETE FROM "orders" WHERE "id" = ANY($1::int[])`,
        [orders],
        removed,
      );
      await removeRows(
        manager,
        'cart items',
        `DELETE FROM "cart_items" WHERE "cartId" IN (SELECT "id" FROM "carts" WHERE "userId" = ANY($1::int[]))`,
        [users],
        removed,
      );
      await removeRows(
        manager,
        'carts',
        `DELETE FROM "carts" WHERE "userId" = ANY($1::int[])`,
        [users],
        removed,
      );
      await removeRows(
        manager,
        'addresses',
        `DELETE FROM "addresses" WHERE "userId" = ANY($1::int[])`,
        [users],
        removed,
      );
      await removeRows(
        manager,
        'customers',
        `DELETE FROM "users" WHERE "id" = ANY($1::int[])`,
        [users],
        removed,
      );
      await removeRows(
        manager,
        'variants',
        `DELETE FROM "product_variants" WHERE "sku" LIKE $1`,
        [markers.skuPattern],
        removed,
      );
      await removeRows(
        manager,
        'products',
        `DELETE FROM "products" WHERE "slug" LIKE $1`,
        [markers.slugPattern],
        removed,
      );
      await removeRows(
        manager,
        'categories',
        `DELETE FROM "categories" WHERE "slug" LIKE $1`,
        [markers.slugPattern],
        removed,
      );
    });
  } catch (error) {
    return {
      ok: false,
      removed: {},
      problems: [
        `Clean-up failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const leftovers = await one<{ users: number; variants: number }>(
    ds,
    `SELECT (SELECT count(*)::int FROM "users" WHERE "email" LIKE $1) AS "users",
            (SELECT count(*)::int FROM "product_variants" WHERE "sku" LIKE $2) AS "variants"`,
    [markers.emailPattern, markers.skuPattern],
  );
  const problems =
    leftovers.users + leftovers.variants > 0
      ? [
          `Rows are still present after clean-up (${leftovers.users} customers, ${leftovers.variants} variants).`,
        ]
      : [];
  return { ok: problems.length === 0, removed, problems };
}
