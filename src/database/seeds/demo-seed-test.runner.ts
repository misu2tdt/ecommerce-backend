import dataSource from '../data-source';
import { seedDemoData } from './demo-seed';
import { assertSafeDemoSeedDatabase } from './demo-seed-safety';

async function run(): Promise<void> {
  assertSafeDemoSeedDatabase(dataSource, 'test');
  await dataSource.initialize();
  try {
    assertSafeDemoSeedDatabase(dataSource, 'test');
    // The browser smoke tests and CI rely on a seed without images. Only
    // DEMO_SEED_TEST_IMAGES=true reads demo-images.json into the test database.
    await seedDemoData(dataSource, {
      target: 'test',
      nodeEnvironment: process.env.NODE_ENV,
      images: process.env.DEMO_SEED_TEST_IMAGES === 'true' ? 'file' : 'none',
    });
    console.log('Isolated browser-test demo seed completed.');
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Test demo seed failed: ${message}`);
  process.exitCode = 1;
});
