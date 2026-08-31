import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/database/database-options';
import { databaseEntities } from '../../src/database/entities';
import { assertSafeTestDatabase } from './database-safety';
import { loadTestEnvironment } from './test-environment';

export function createTestDataSource(): DataSource {
  const environment = loadTestEnvironment();

  return new DataSource({
    ...createDatabaseOptions(
      (key) => environment[key as keyof typeof environment],
    ),
    entities: databaseEntities,
    migrations: [join(process.cwd(), 'src', 'database', 'migrations', '*.ts')],
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
  });
}

export async function initializeTestDatabase(): Promise<DataSource> {
  const dataSource = createTestDataSource();
  assertSafeTestDatabase(dataSource);

  await dataSource.initialize();

  try {
    assertSafeTestDatabase(dataSource);
    await dataSource.runMigrations();
    return dataSource;
  } catch (error) {
    await dataSource.destroy();
    throw error;
  }
}

export async function cleanTestDatabase(dataSource: DataSource): Promise<void> {
  assertSafeTestDatabase(dataSource);

  await dataSource.transaction(async (manager) => {
    await manager.query('DELETE FROM "payment_events"');
    await manager.query('DELETE FROM "payments"');
    await manager.query('DELETE FROM "product_reviews"');
    await manager.query('DELETE FROM "wishlist_items"');
    await manager.query('DELETE FROM "cart_items"');
    await manager.query('DELETE FROM "carts"');
    await manager.query('DELETE FROM "order_items"');
    await manager.query('DELETE FROM "orders"');
    await manager.query('DELETE FROM "addresses"');
    await manager.query('DELETE FROM "product_variants"');
    await manager.query('DELETE FROM "product_images"');
    await manager.query('DELETE FROM "products"');
    await manager.query('DELETE FROM "coupons"');
    await manager.query('DELETE FROM "brands"');
    await manager.query('DELETE FROM "categories"');
    await manager.query('DELETE FROM "users"');
  });
}
