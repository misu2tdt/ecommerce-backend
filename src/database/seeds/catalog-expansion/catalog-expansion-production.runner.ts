import dataSource from '../../data-source';
import { assertSafeDemoSeedDatabase } from '../demo-seed-safety';
import {
  formatCatalogExpansionSummary,
  seedCatalogExpansion,
} from './catalog-expansion';

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
    const summary = await seedCatalogExpansion(dataSource, {
      target: 'production',
      nodeEnvironment: process.env.NODE_ENV,
      productionApproval: approval,
    });
    console.log('Production catalog expansion (batch 1) completed');
    for (const line of formatCatalogExpansionSummary(summary)) {
      console.log(line);
    }
    console.log(
      'Only missing rows were added; nothing that exists was changed.',
    );
    console.log(
      'No user or ADMIN account is created or updated by this command.',
    );
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Production catalog expansion failed: ${message}`);
  process.exitCode = 1;
});
