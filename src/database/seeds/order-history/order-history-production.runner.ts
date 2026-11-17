import dataSource from '../../data-source';
import { assertSafeDemoSeedDatabase } from '../demo-seed-safety';
import { formatOrderHistorySummary, seedOrderHistory } from './order-history';

const approval = {
  confirmation: process.env.PRODUCTION_DEMO_SEED_CONFIRM,
  database: process.env.PRODUCTION_DEMO_SEED_DATABASE,
};

async function run(): Promise<void> {
  assertSafeDemoSeedDatabase(
    dataSource,
    'production',
    process.env.NODE_ENV,
    approval,
  );
  await dataSource.initialize();
  try {
    const summary = await seedOrderHistory(dataSource, {
      target: 'production',
      nodeEnvironment: process.env.NODE_ENV,
      productionApproval: approval,
    });
    if (summary.status === 'already-seeded') {
      console.log(
        'Production order history is already seeded; nothing was added.',
      );
    } else {
      console.log('Production order history completed');
    }
    for (const line of formatOrderHistorySummary(summary)) console.log(line);
    console.log('Only new rows were added; nothing that exists was changed.');
    console.log(
      'No ADMIN account is created or updated by this command. The seeded customers cannot log in.',
    );
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Production order history failed: ${message}`);
  process.exitCode = 1;
});
