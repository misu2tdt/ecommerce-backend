import dataSource from '../../data-source';
import { assertSafeDemoSeedDatabase } from '../demo-seed-safety';
import {
  formatCatalogExpansionSummary,
  seedCatalogExpansion,
} from './catalog-expansion';

async function run(): Promise<void> {
  assertSafeDemoSeedDatabase(dataSource, 'development');
  console.log('Catalog expansion target: ecommerce_dev');

  await dataSource.initialize();
  try {
    assertSafeDemoSeedDatabase(dataSource, 'development');
    const summary = await seedCatalogExpansion(dataSource, {
      target: 'development',
      nodeEnvironment: process.env.NODE_ENV,
    });
    for (const line of formatCatalogExpansionSummary(summary)) {
      console.log(line);
    }
    console.log('Catalog expansion (batch 1) completed.');
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Catalog expansion failed: ${message}`);
  process.exitCode = 1;
});
