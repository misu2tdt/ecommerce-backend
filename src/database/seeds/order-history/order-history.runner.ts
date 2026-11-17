import dataSource from '../../data-source';
import { assertSafeDemoSeedDatabase } from '../demo-seed-safety';
import { formatOrderHistorySummary, seedOrderHistory } from './order-history';

async function run(): Promise<void> {
  assertSafeDemoSeedDatabase(dataSource, 'development');
  console.log('Order history target: ecommerce_dev');

  await dataSource.initialize();
  try {
    assertSafeDemoSeedDatabase(dataSource, 'development');
    const summary = await seedOrderHistory(dataSource, {
      target: 'development',
      nodeEnvironment: process.env.NODE_ENV,
    });
    if (summary.status === 'already-seeded') {
      console.log('Order history is already seeded; nothing was added.');
    }
    for (const line of formatOrderHistorySummary(summary)) console.log(line);
    if (summary.status === 'seeded') console.log('Order history completed.');
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Order history failed: ${message}`);
  process.exitCode = 1;
});
