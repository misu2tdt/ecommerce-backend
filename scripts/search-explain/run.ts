// Measures the real product search before and after the trigram index.
//
//   npm.cmd run search:explain -- [--sizes 1000,10000,50000] [--runs 5] [--plans]
//
// It runs against the isolated test database only (the same guard as the
// concurrency check: NODE_ENV=test, DB_NAME=ecommerce_test, a loopback host, an
// explicit DB_PORT that is not 5432 and ECOMMERCE_TEST_DB_PASSWORD). It seeds
// nothing permanently: for each size it inserts scratch products (slug prefix
// "search-explain-" and one scratch category), measures, and deletes exactly
// those rows again, also when something fails.
//
// "After" is the database as it is, with the index the migration created.
// "Before" is the same database inside a transaction that drops the index and
// is rolled back, so the index is always back when the run ends. The migration
// must be applied to the test database first.

import 'reflect-metadata';
import { DataSource, type Logger } from 'typeorm';
import { databaseEntities } from '../../src/database/entities';
import { PRODUCT_NAME_TRIGRAM_INDEX } from '../../src/database/migrations/1787677200000-AddProductNameTrigramIndex';
import { Brand } from '../../src/brands/entities/brand.entity';
import { Category } from '../../src/categories/entities/category.entity';
import type { ImageStorageService } from '../../src/image-storage/image-storage.service';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductsService } from '../../src/products/products.service';
import {
  assertConnectedToTestDatabase,
  assertSafeLoadTestEnvironment,
  UnsafeEnvironmentError,
} from '../loadtest/guard';
import {
  SCRATCH_CATEGORY_SLUG,
  SCRATCH_DELETE_SQL,
  SEARCH_TERMS,
  scratchInsertSql,
} from './dataset';
import {
  describeScan,
  formatMs,
  median,
  summarisePlan,
  usesIndex,
  type PlanSummary,
} from './plan-summary';

interface Options {
  sizes: number[];
  runs: number;
  // Also print the full plan text of the "after" state for every statement.
  plans: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    sizes: [1_000, 10_000, 50_000],
    runs: 5,
    plans: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--plans') {
      options.plans = true;
    } else if (argument === '--sizes') {
      const sizes = (value ?? '').split(',').map((part) => Number(part));
      if (
        sizes.length === 0 ||
        sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 500_000)
      ) {
        throw new Error(
          '--sizes needs whole numbers from 1 to 500000, for example 1000,50000',
        );
      }
      options.sizes = sizes;
      index += 1;
    } else if (argument === '--runs') {
      const runs = Number(value);
      if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
        throw new Error('--runs needs a whole number from 1 to 50');
      }
      options.runs = runs;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

// Records the SQL TypeORM sends while it is switched on, so the statements that
// are measured are the ones the service really runs, not a copy of them.
class RecordingLogger implements Logger {
  capturing = false;
  readonly statements: Array<{ sql: string; parameters: unknown[] }> = [];
  logQuery(query: string, parameters?: unknown[]): void {
    if (this.capturing)
      this.statements.push({ sql: query, parameters: parameters ?? [] });
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

interface Measurement {
  summary: PlanSummary;
  medianMs: number;
  rows: unknown;
}

interface Line {
  size: number;
  term: string;
  statement: 'count' | 'page';
  before: Measurement;
  after: Measurement;
}

type Queryable = {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
};

// DataSource.query answers with any; every query here says what it expects.
async function rows<T>(
  db: Queryable,
  sql: string,
  parameters?: unknown[],
): Promise<T> {
  return (await db.query(sql, parameters)) as T;
}

async function measure(
  db: Queryable,
  statement: { sql: string; parameters: unknown[] },
  runs: number,
): Promise<Measurement> {
  const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`;
  // The first run warms the cache and is not counted.
  await db.query(explain, statement.parameters);
  const times: number[] = [];
  let summary!: PlanSummary;
  for (let run = 0; run < runs; run += 1) {
    const result = await rows<Array<Record<string, unknown>>>(
      db,
      explain,
      statement.parameters,
    );
    summary = summarisePlan(result[0]['QUERY PLAN']);
    times.push(summary.executionMs);
  }
  const resultRows = await rows<unknown>(
    db,
    statement.sql,
    statement.parameters,
  );
  return { summary, medianMs: median(times), rows: resultRows };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const config = assertSafeLoadTestEnvironment(process.env);
  const recorder = new RecordingLogger();
  const dataSource = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    entities: databaseEntities,
    logger: recorder,
    logging: ['query'],
    synchronize: false,
  });
  await dataSource.initialize();

  const lines: Line[] = [];
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

    const indexRows = await rows<unknown[]>(
      dataSource,
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [PRODUCT_NAME_TRIGRAM_INDEX],
    );
    if (indexRows.length === 0) {
      throw new Error(
        `The index ${PRODUCT_NAME_TRIGRAM_INDEX} does not exist in the test database. Apply the migrations to it first (npm.cmd run migration:run with the same DB_* variables).`,
      );
    }

    const service = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(Category),
      dataSource.getRepository(Brand),
      dataSource.getRepository(ProductImage),
      {} as ImageStorageService,
    );

    for (const size of options.sizes) {
      await dataSource.query(SCRATCH_DELETE_SQL);
      await dataSource.query(`DELETE FROM "categories" WHERE "slug" = $1`, [
        SCRATCH_CATEGORY_SLUG,
      ]);
      const category = await rows<Array<{ id: number }>>(
        dataSource,
        `INSERT INTO "categories" ("name", "slug") VALUES ('Search explain scratch', $1) RETURNING "id"`,
        [SCRATCH_CATEGORY_SLUG],
      );
      // Every size starts from the same physical state. Without this, rows
      // deleted by the previous size leave a bloated table, and a bulk insert
      // leaves the trigram index's "pending list" unmerged; both change the
      // planner's cost estimates and make the result depend on the run order.
      // VACUUM FULL rewrites the table and rebuilds its indexes; the VACUUM
      // after the insert merges the pending list and refreshes the statistics.
      await dataSource.query('VACUUM FULL "products"');
      await dataSource.query(scratchInsertSql(), [category[0].id, size]);
      await dataSource.query('VACUUM (ANALYZE) "products"');

      for (const { term } of SEARCH_TERMS) {
        // The statements the service sends for the first page of this search.
        recorder.statements.length = 0;
        recorder.capturing = true;
        await service.findPage({ q: term }, { page: 1, limit: 20, offset: 0 });
        recorder.capturing = false;
        const count = recorder.statements.find((entry) =>
          /COUNT\(/i.test(entry.sql),
        );
        const page = recorder.statements.find(
          (entry) =>
            /LIMIT/i.test(entry.sql) &&
            /ORDER BY/i.test(entry.sql) &&
            !/COUNT\(/i.test(entry.sql) &&
            !/LEFT JOIN "product_images"/i.test(entry.sql),
        );
        if (!count || !page)
          throw new Error(`Could not find the search statements for "${term}"`);

        for (const [statement, label] of [
          [count, 'count'],
          [page, 'page'],
        ] as const) {
          const after = await measure(dataSource, statement, options.runs);
          if (options.plans) {
            const text = await rows<Array<Record<string, string>>>(
              dataSource,
              `EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`,
              statement.parameters,
            );
            console.log(
              `\n--- ${size} products, "${term}", ${label}, trigram index present ---\n${statement.sql}\n${text.map((row) => row['QUERY PLAN']).join('\n')}`,
            );
          }

          // Before: the same statement with the index dropped, in a transaction
          // that is always rolled back.
          const runner = dataSource.createQueryRunner();
          await runner.connect();
          await runner.startTransaction();
          let before: Measurement;
          try {
            await runner.query(
              `DROP INDEX "public"."${PRODUCT_NAME_TRIGRAM_INDEX}"`,
            );
            before = await measure(runner, statement, options.runs);
          } finally {
            await runner.rollbackTransaction();
            await runner.release();
          }
          lines.push({ size, term, statement: label, before, after });
        }
      }
    }
  } finally {
    await dataSource.query(SCRATCH_DELETE_SQL);
    await dataSource.query(`DELETE FROM "categories" WHERE "slug" = $1`, [
      SCRATCH_CATEGORY_SLUG,
    ]);
    // Give the space of the scratch rows back, so the test database is left as
    // small as it was.
    await dataSource.query('VACUUM FULL "products"');
    await dataSource.destroy();
  }

  print(lines, options, version);
  const different = lines.filter(
    (line) =>
      JSON.stringify(line.before.rows) !== JSON.stringify(line.after.rows),
  );
  if (different.length > 0) {
    console.error(
      `The index changed a result for ${different.length} measurement(s). This must not happen.`,
    );
    return 1;
  }
  return 0;
}

function print(lines: Line[], options: Options, version: string): void {
  console.log(
    `PostgreSQL ${version}; ${options.runs} timed runs after one warm-up, median shown.`,
  );
  console.log(
    'These are local numbers from one machine and the isolated test database, not production.\n',
  );
  console.log(
    '| Products | Search term | Statement | State | How "products" is read | Execution (median) | Planning | Buffers hit / read |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const line of lines) {
    for (const [state, m] of [
      ['before (no index)', line.before],
      ['after (trigram index)', line.after],
    ] as const) {
      console.log(
        `| ${line.size.toLocaleString('en-US')} | ${line.term} | ${line.statement} | ${state} | ${describeScan(m.summary)} | ${formatMs(m.medianMs)} | ${formatMs(m.summary.planningMs)} | ${m.summary.sharedHit} / ${m.summary.sharedRead} |`,
      );
    }
  }
  const used = lines.filter((line) =>
    usesIndex(line.after.summary, PRODUCT_NAME_TRIGRAM_INDEX),
  );
  console.log(
    `\nThe planner used the trigram index in ${used.length} of ${lines.length} measurements.`,
  );
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
