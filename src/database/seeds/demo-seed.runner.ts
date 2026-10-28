import dataSource from '../data-source';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_CUSTOMER_EMAIL,
  DEMO_PASSWORD,
  seedDemoData,
} from './demo-seed';
import { assertSafeDemoSeedDatabase } from './demo-seed-safety';

async function run(): Promise<void> {
  assertSafeDemoSeedDatabase(dataSource, 'development');
  console.log('Demo seed target: ecommerce_dev');

  await dataSource.initialize();
  try {
    assertSafeDemoSeedDatabase(dataSource, 'development');
    const result = await seedDemoData(dataSource, {
      target: 'development',
      nodeEnvironment: process.env.NODE_ENV,
    });
    console.log(`Categories: ${result.categories}`);
    console.log(`Brands: ${result.brands}`);
    console.log(`Products: ${result.products}`);
    console.log(`Variants: ${result.variants}`);
    console.log(`Product images: ${result.images}`);
    console.log(`Demo users: ${result.users}`);
    console.log(`Orders: ${result.orders}`);
    console.log(`Reviews: ${result.reviews}`);
    console.log(`Demo customer: ${DEMO_CUSTOMER_EMAIL}`);
    console.log(`Demo admin: ${DEMO_ADMIN_EMAIL}`);
    console.log(`Development-only password: ${DEMO_PASSWORD}`);
    console.log('Demo seed completed.');
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Demo seed failed: ${message}`);
  process.exitCode = 1;
});
