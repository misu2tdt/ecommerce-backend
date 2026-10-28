import { DataSource } from 'typeorm';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const MIGRATION_NAME = 'OneActivePaymentPerOrder1787331600000';
const INDEX_NAME = 'UQ_payments_one_active_per_order';

describe('One active Payment per Order migration', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.runMigrations();
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  // Fails fast, before touching the schema, if the migration does not exist.
  function expectMigrationExists() {
    expect(dataSource.migrations.map((migration) => migration.name)).toContain(
      MIGRATION_NAME,
    );
  }

  function indexDefinitions() {
    return dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [INDEX_NAME],
    );
  }

  it('applies, matches the entity, and reverts on an empty database', async () => {
    expectMigrationExists();
    await dataSource.query('DROP SCHEMA public CASCADE;');
    await dataSource.query('CREATE SCHEMA public;');

    await dataSource.runMigrations();

    expect(await dataSource.showMigrations()).toBe(false);
    const created = await indexDefinitions();
    expect(created).toHaveLength(1);
    expect(created[0].indexdef).toContain('UNIQUE INDEX');
    expect(created[0].indexdef).toContain('("orderId")');
    for (const status of ['pending', 'processing', 'succeeded'])
      expect(created[0].indexdef).toContain(`'${status}'`);
    expect(created[0].indexdef).not.toContain(`'failed'`);
    expect(created[0].indexdef).not.toContain(`'cancelled'`);

    // The Payment entity declares the same index: TypeORM must not want to
    // create or change it.
    const drift = await dataSource.driver.createSchemaBuilder().log();
    expect(
      drift.upQueries.filter((entry) => entry.query.includes(INDEX_NAME)),
    ).toEqual([]);

    await dataSource.undoLastMigration();
    expect(await indexDefinitions()).toHaveLength(0);

    await dataSource.runMigrations();
    expect(await indexDefinitions()).toHaveLength(1);
  });

  it('refuses to run, listing order ids, when an Order already has two active Payments', async () => {
    expectMigrationExists();
    await dataSource.runMigrations();
    await dataSource.undoLastMigration();

    const userId = await insertUser();
    const violatingOrderId = await insertOrder(userId);
    const cleanOrderId = await insertOrder(userId);
    const duplicatePaymentIds = [
      await insertPayment(violatingOrderId, 'legacy-key-pending', 'pending'),
      await insertPayment(
        violatingOrderId,
        'legacy-key-processing',
        'processing',
      ),
    ];
    await insertPayment(violatingOrderId, 'legacy-key-failed', 'failed');
    // One active plus one failed Payment is fine and must not be reported.
    await insertPayment(cleanOrderId, 'legacy-key-clean-active', 'pending');
    await insertPayment(cleanOrderId, 'legacy-key-clean-failed', 'failed');

    const failure = await dataSource.runMigrations().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(INDEX_NAME);
    expect(message).toContain(String(violatingOrderId));
    expect(message).not.toMatch(new RegExp(`\\b${cleanOrderId}\\b`));
    expect(await indexDefinitions()).toHaveLength(0);
    expect(await dataSource.showMigrations()).toBe(true);
    const remaining = await dataSource.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM "payments"`,
    );
    expect(remaining[0].count).toBe(5);

    // Once a human resolves the duplicate, the migration applies.
    await dataSource.query(
      `UPDATE "payments" SET "status" = 'cancelled' WHERE "id" = $1`,
      [duplicatePaymentIds[0]],
    );
    await dataSource.runMigrations();
    expect(await indexDefinitions()).toHaveLength(1);
    expect(await dataSource.showMigrations()).toBe(false);
  });

  async function insertUser() {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "users" ("email", "password", "role", "createdAt")
       VALUES ('migration-user@example.test', 'hash', '${UserRole.USER}', NOW())
       RETURNING "id"`,
    );
    return rows[0].id;
  }

  async function insertOrder(userId: number) {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "orders" ("userId", "totalPrice", "status", "shippingAddress", "createdAt", "updatedAt")
       VALUES ($1, 400000, '${OrderStatus.PENDING}', $2, NOW(), NOW())
       RETURNING "id"`,
      [
        userId,
        JSON.stringify({
          recipientName: 'Migration Recipient',
          phone: '+84900000000',
          addressLine1: '1 Migration St',
          city: 'HCMC',
          countryCode: 'VN',
        }),
      ],
    );
    return rows[0].id;
  }

  async function insertPayment(orderId: number, key: string, status: string) {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', NULL, $2, 400000, 'VND', $3)
       RETURNING "id"`,
      [orderId, key, status],
    );
    return rows[0].id;
  }
});
