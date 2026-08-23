import dataSource from '../data-source';
import { seedDemoData } from './demo-seed';
import { assertSafeDemoSeedDatabase } from './demo-seed-safety';

async function run(): Promise<void> {
  assertSafeDemoSeedDatabase(dataSource, 'test');
  await dataSource.initialize();
  try {
    assertSafeDemoSeedDatabase(dataSource, 'test');
    await seedDemoData(dataSource, {
      target: 'test',
      nodeEnvironment: process.env.NODE_ENV,
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
