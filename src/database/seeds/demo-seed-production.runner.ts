import dataSource from '../data-source';
import { DEMO_CUSTOMER_EMAIL, seedDemoData } from './demo-seed';
import { assertSafeDemoSeedDatabase } from './demo-seed-safety';

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
    const result = await seedDemoData(dataSource, {
      target: 'production',
      nodeEnvironment: process.env.NODE_ENV,
      productionApproval: approval,
    });
    console.log(
      `Production portfolio demo seed completed categories=${result.categories} brands=${result.brands} products=${result.products} variants=${result.variants} users=${result.users} orders=${result.orders} reviews=${result.reviews}`,
    );
    console.log(`Demo customer: ${DEMO_CUSTOMER_EMAIL}`);
    console.log('No ADMIN account is created or updated by this command.');
  } finally {
    await dataSource.destroy();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Production demo seed failed: ${message}`);
  process.exitCode = 1;
});
