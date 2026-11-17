// Measures the real analytics statements, to decide whether an index is needed.
//
//   npm.cmd run analytics:explain -- [--orders 200000] [--runs 5]
//
// Isolated test database only (the same guard as the concurrency check and the
// search measurement: NODE_ENV=test, DB_NAME=ecommerce_test, a loopback host, an
// explicit DB_PORT that is not 5432 and ECOMMERCE_TEST_DB_PASSWORD). It inserts
// scratch rows (every one carries the marker "analytics-explain" or the SKU prefix
// "AE-"), measures, and deletes exactly those rows again, also when something
// fails.
//
// "Without" is the schema as it is. "With" is the same database inside a
// transaction that adds the candidate indexes and is rolled back, so nothing is
// ever left behind. The statements are the ones AnalyticsService sends: they come
// from the same builders, not from a copy.

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  resolveAnalyticsRange,
  type AnalyticsRange,
  type DateSpan,
} from '../../src/analytics/analytics-range';
import {
  ordersByStatusStatement,
  overviewStatement,
  revenueByDayStatement,
  topProductsStatement,
  type Statement,
} from '../../src/analytics/analytics.queries';
import { databaseEntities } from '../../src/database/entities';
import {
  assertConnectedToTestDatabase,
  assertSafeLoadTestEnvironment,
  UnsafeEnvironmentError,
} from '../loadtest/guard';
import {
  formatMs,
  median,
  readExplain,
  type PlanNode,
} from '../search-explain/plan-summary';

const MARKER = 'analytics-explain';
const SKU_PREFIX = 'AE-';

interface Options {
  orders: number;
  runs: number;
  // Also print the full plan text of every statement on the current schema.
  plans: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { orders: 100_000, runs: 5, plans: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = Number(argv[index + 1]);
    if (argument === '--plans') {
      options.plans = true;
      continue;
    }
    if (argument === '--orders') {
      if (!Number.isInteger(value) || value < 1000 || value > 2_000_000) {
        throw new Error('--orders needs a whole number from 1000 to 2000000');
      }
      options.orders = value;
    } else if (argument === '--runs') {
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error('--runs needs a whole number from 1 to 50');
      }
      options.runs = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }
  return options;
}

type Queryable = {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
};

async function rows<T>(
  db: Queryable,
  sql: string,
  parameters?: unknown[],
): Promise<T> {
  return (await db.query(sql, parameters)) as T;
}

// The scratch dataset: a category, 40 products with 6 variants each, a buyer,
// 2,000 customers over the last 400 days, and the orders with 1 to 3 items each.
// Everything is a function of the row number, so a given size is always the same.
async function insertScratch(db: Queryable, orders: number): Promise<void> {
  await db.query(
    `INSERT INTO "categories" ("name", "slug") VALUES ('Analytics scratch', '${MARKER}-category')`,
  );
  await db.query(
    `INSERT INTO "products" ("name", "slug", "status", "categoryId")
     SELECT 'Analytics scratch ' || g, '${MARKER}-' || g, 'active',
            (SELECT "id" FROM "categories" WHERE "slug" = '${MARKER}-category')
     FROM generate_series(1, 40) g`,
  );
  await db.query(
    `INSERT INTO "product_variants" ("productId", "sku", "name", "price", "stock", "attributes", "isActive", "position")
     SELECT p."id", '${SKU_PREFIX}' || p."id" || '-' || v, 'Variant ' || v,
            100000 + (p."id" % 7) * 50000 + v * 10000, 10, '{}', true, v
     FROM "products" p, generate_series(1, 6) v
     WHERE p."slug" LIKE '${MARKER}-%'`,
  );
  await db.query(
    `INSERT INTO "users" ("email", "password", "role", "createdAt")
     SELECT '${MARKER}-' || g || '@example.com', 'not-a-real-hash', 'user',
            (now() AT TIME ZONE current_setting('TimeZone')) - ((CAST(g AS bigint) * 7919) % 576000) * interval '1 minute'
     FROM generate_series(0, 2000) g`,
  );
  // Orders over 400 days, 85% delivered and the rest spread over the other
  // statuses. Order 0 of the series is the buyer's own row of users above.
  await db.query(
    `INSERT INTO "orders" ("subtotalPrice", "discountPrice", "totalPrice", "status", "shippingAddress", "userId", "createdAt", "updatedAt")
     SELECT t, 0, t,
            CASE WHEN g % 100 < 85 THEN 'delivered' WHEN g % 100 < 88 THEN 'shipped'
                 WHEN g % 100 < 90 THEN 'processing' WHEN g % 100 < 92 THEN 'confirmed'
                 WHEN g % 100 < 94 THEN 'pending' ELSE 'cancelled' END,
            '{}'::jsonb,
            (SELECT "id" FROM "users" WHERE "email" = '${MARKER}-0@example.com'),
            (now() AT TIME ZONE current_setting('TimeZone')) - ((CAST(g AS bigint) * 7919) % 576000) * interval '1 minute',
            (now() AT TIME ZONE current_setting('TimeZone')) - ((CAST(g AS bigint) * 7919) % 576000) * interval '1 minute'
     FROM (SELECT g, 100000 + (g % 50) * 20000 AS t FROM generate_series(1, CAST($1 AS int)) g) s(g, t)`,
    [orders],
  );
  // 1 to 3 items per order, each a different variant of the scratch catalog.
  await db.query(
    `INSERT INTO "order_items" ("quantity", "price", "orderId", "variantId")
     SELECT CAST(1 + (o.n % 2) AS int), v."price", o."id", v."id"
     FROM (
       SELECT "id", row_number() OVER (ORDER BY "id") AS n
       FROM "orders"
       WHERE "userId" = (SELECT "id" FROM "users" WHERE "email" = '${MARKER}-0@example.com')
     ) o
     CROSS JOIN generate_series(1, 3) k
     INNER JOIN (
       SELECT "id", "price", row_number() OVER (ORDER BY "id") AS rn, COUNT(*) OVER () AS total
       FROM "product_variants" WHERE "sku" LIKE '${SKU_PREFIX}%'
     ) v ON v.rn = 1 + ((o.n * k) % v.total)
     WHERE k <= 1 + (o.n % 3)`,
  );
}

async function deleteScratch(db: Queryable): Promise<void> {
  const buyer = `(SELECT "id" FROM "users" WHERE "email" LIKE '${MARKER}-%')`;
  await db.query(
    `DELETE FROM "order_items" WHERE "orderId" IN (SELECT "id" FROM "orders" WHERE "userId" IN ${buyer})`,
  );
  await db.query(`DELETE FROM "orders" WHERE "userId" IN ${buyer}`);
  await db.query(`DELETE FROM "users" WHERE "email" LIKE '${MARKER}-%'`);
  await db.query(
    `DELETE FROM "product_variants" WHERE "sku" LIKE '${SKU_PREFIX}%'`,
  );
  await db.query(`DELETE FROM "products" WHERE "slug" LIKE '${MARKER}-%'`);
  await db.query(
    `DELETE FROM "categories" WHERE "slug" = '${MARKER}-category'`,
  );
}

interface Reading {
  scans: string;
  executionMs: number;
  planningMs: number;
  buffers: number;
}

// How each table of the plan is read, for example
// "orders: Index Scan (IDX_orders_created_at); order_items: Seq Scan".
function scansOf(root: PlanNode): string {
  const found = new Map<string, string>();
  const visit = (node: PlanNode): void => {
    const relation = node['Relation Name'];
    if (
      relation &&
      ['orders', 'order_items', 'users'].includes(relation) &&
      /Scan$/.test(node['Node Type'])
    ) {
      const how = node['Index Name']
        ? `${node['Node Type']} (${node['Index Name']})`
        : node['Node Type'];
      const known = found.get(relation);
      if (!known) found.set(relation, how);
      else if (!known.includes(how)) found.set(relation, `${known}, ${how}`);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return [...found].map(([table, how]) => `${table}: ${how}`).join('; ');
}

async function measure(
  db: Queryable,
  statement: Statement,
  runs: number,
): Promise<Reading> {
  const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`;
  const explainOnce = async () => {
    const result = await rows<Array<Record<string, unknown>>>(
      db,
      explain,
      statement.params,
    );
    return readExplain(result[0]['QUERY PLAN']);
  };
  let last = await explainOnce(); // warm-up, not counted
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    last = await explainOnce();
    times.push(last['Execution Time'] ?? 0);
  }
  return {
    scans: scansOf(last.Plan),
    executionMs: median(times),
    planningMs: last['Planning Time'] ?? 0,
    buffers:
      (last.Plan['Shared Hit Blocks'] ?? 0) +
      (last.Plan['Shared Read Blocks'] ?? 0),
  };
}

interface Window {
  label: string;
  range: AnalyticsRange;
  previous: DateSpan;
}

// The default window (30 days ending today) and the longest allowed (366 days).
function windows(): Window[] {
  const thirty = resolveAnalyticsRange({});
  const start = new Date(`${thirty.range.to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 365);
  const long = resolveAnalyticsRange({
    from: start.toISOString().slice(0, 10),
    to: thirty.range.to,
  });
  return [
    { label: '30 days', range: thirty.range, previous: thirty.previous },
    { label: '366 days', range: long.range, previous: long.previous },
  ];
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const config = assertSafeLoadTestEnvironment(process.env);
  const dataSource = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    entities: databaseEntities,
    synchronize: false,
  });
  await dataSource.initialize();

  const lines: string[] = [];
  let version = '';
  try {
    const [{ current_database: connected }] = await rows<
      Array<{ current_database: string }>
    >(dataSource, 'SELECT current_database()');
    assertConnectedToTestDatabase({ database: connected });
    version = (
      await rows<Array<{ server_version: string }>>(
        dataSource,
        'SHOW server_version',
      )
    )[0].server_version;

    await deleteScratch(dataSource);
    await insertScratch(dataSource, options.orders);
    await dataSource.query('VACUUM (ANALYZE) "orders"');
    await dataSource.query('VACUUM (ANALYZE) "order_items"');
    await dataSource.query('VACUUM (ANALYZE) "users"');

    const counts = await rows<Array<{ orders: string; items: string }>>(
      dataSource,
      `SELECT (SELECT COUNT(*) FROM "orders") AS orders, (SELECT COUNT(*) FROM "order_items") AS items`,
    );

    const statementsFor = (window: Window): Array<[string, Statement]> => [
      ['overview', overviewStatement(window.range, window.previous)],
      ['revenue-by-day', revenueByDayStatement(window.range)],
      ['orders-by-status', ordersByStatusStatement(window.range)],
      ['top-products', topProductsStatement(window.range, 10)],
    ];

    for (const window of windows()) {
      for (const [name, statement] of statementsFor(window)) {
        const without = await measure(dataSource, statement, options.runs);
        if (options.plans) {
          const text = await rows<Array<Record<string, string>>>(
            dataSource,
            `EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`,
            statement.params,
          );
          console.log(
            `\n--- ${window.label}, ${name}, current schema ---\n${text.map((row) => row['QUERY PLAN']).join('\n')}`,
          );
        }

        const runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        let withIndexes: Reading;
        try {
          await runner.query(
            `CREATE INDEX "IDX_scratch_orders_created_at" ON "orders" ("createdAt")`,
          );
          await runner.query(
            `CREATE INDEX "IDX_scratch_order_items_order" ON "order_items" ("orderId")`,
          );
          await runner.query('ANALYZE "orders"');
          await runner.query('ANALYZE "order_items"');
          withIndexes = await measure(runner, statement, options.runs);
        } finally {
          await runner.rollbackTransaction();
          await runner.release();
        }

        for (const [state, reading] of [
          ['current schema', without],
          ['with candidate indexes', withIndexes],
        ] as const) {
          lines.push(
            `| ${window.label} | ${name} | ${state} | ${reading.scans} | ${formatMs(reading.executionMs)} | ${formatMs(reading.planningMs)} | ${reading.buffers} |`,
          );
        }
      }
    }

    console.log(
      `PostgreSQL ${version}; ${Number(counts[0].orders).toLocaleString('en-US')} scratch orders, ${Number(counts[0].items).toLocaleString('en-US')} order items; ${options.runs} timed runs after one warm-up, median shown.`,
    );
    console.log(
      'These are local numbers from one machine and the isolated test database, not production.\n',
    );
    console.log(
      '| Window | Statement | State | How the tables are read | Execution (median) | Planning | Buffers |',
    );
    console.log('| --- | --- | --- | --- | --- | --- | --- |');
    for (const line of lines) console.log(line);
  } finally {
    await deleteScratch(dataSource);
    await dataSource.query('VACUUM FULL "orders"');
    await dataSource.query('VACUUM FULL "order_items"');
    await dataSource.destroy();
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof UnsafeEnvironmentError ? 2 : 3;
  },
);
