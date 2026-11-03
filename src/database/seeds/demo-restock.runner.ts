import dataSource from '../data-source';
import {
  formatRestockSummary,
  parseRestockArguments,
  resolveRestockTarget,
  restockDemoVariants,
} from './demo-restock';
import { assertSafeDemoSeedDatabase } from './demo-seed-safety';

// npm run demo:restock [-- --dry-run]
//   development: needs the ecommerce_dev database
//   NODE_ENV=test: needs the ecommerce_test database
//   NODE_ENV=production: needs PRODUCTION_DEMO_SEED_CONFIRM and
//   PRODUCTION_DEMO_SEED_DATABASE, exactly like the production seed
// (the compiled variant is `npm run demo:restock:production`).
async function run(): Promise<void> {
  const { dryRun } = parseRestockArguments(process.argv.slice(2));
  const target = resolveRestockTarget(process.env.NODE_ENV);
  const approval = {
    confirmation: process.env.PRODUCTION_DEMO_SEED_CONFIRM,
    database: process.env.PRODUCTION_DEMO_SEED_DATABASE,
  };
  const options = {
    target,
    nodeEnvironment: process.env.NODE_ENV,
    productionApproval: target === 'production' ? approval : undefined,
    dryRun,
  };

  // Refuse before connecting if the target is not allowed.
  assertSafeDemoSeedDatabase(
    dataSource,
    target,
    options.nodeEnvironment,
    options.productionApproval,
  );
  console.log(`Demo restock target: ${target}${dryRun ? ' (dry run)' : ''}`);

  await dataSource.initialize();
  try {
    const summary = await restockDemoVariants(dataSource, options);
    for (const line of formatRestockSummary(summary)) console.log(line);
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Demo restock failed: ${message}`);
  process.exitCode = 1;
});
