import { DataSource } from 'typeorm';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { UserRole } from '../../src/users/entities/user-role.enum';
import {
  cleanTestDatabase,
  initializeTestDatabase,
  undoMigrationsThrough,
} from './test-database';

const MIGRATION_NAME = 'AddPaymentEventResolution1787418000000';
const NEW_COLUMNS = ['resolvedAt', 'resolvedByUserId', 'resolutionNote'];
const CHECK_NAME = 'CHK_payment_events_resolution';
const FK_NAME = 'FK_payment_events_resolved_by';
const INDEX_NAME = 'IDX_payment_events_unresolved_reconciliation';

describe('Payment event resolution migration', () => {
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

  async function resolutionColumns() {
    return dataSource.query<
      { column_name: string; data_type: string; is_nullable: string }[]
    >(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'payment_events' AND column_name = ANY($1)
       ORDER BY column_name`,
      [NEW_COLUMNS],
    );
  }

  async function constraintNames() {
    const rows = await dataSource.query<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1)`,
      [[CHECK_NAME, FK_NAME]],
    );
    return rows.map((row) => row.conname).sort();
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
    expect(await resolutionColumns()).toEqual([
      {
        column_name: 'resolutionNote',
        data_type: 'character varying',
        is_nullable: 'YES',
      },
      {
        column_name: 'resolvedAt',
        data_type: 'timestamp without time zone',
        is_nullable: 'YES',
      },
      {
        column_name: 'resolvedByUserId',
        data_type: 'integer',
        is_nullable: 'YES',
      },
    ]);
    expect(await constraintNames()).toEqual([CHECK_NAME, FK_NAME]);
    const deleteRule = await dataSource.query<{ delete_rule: string }[]>(
      `SELECT delete_rule FROM information_schema.referential_constraints
       WHERE constraint_name = $1`,
      [FK_NAME],
    );
    expect(deleteRule[0].delete_rule).toBe('SET NULL');
    const index = await indexDefinitions();
    expect(index).toHaveLength(1);
    expect(index[0].indexdef).toContain('requires_reconciliation');
    expect(index[0].indexdef).toContain('"resolvedAt" IS NULL');

    // The PaymentEvent entity declares the same columns, check, key and index:
    // TypeORM must not want to create or change any of them.
    const drift = await dataSource.driver.createSchemaBuilder().log();
    const mentionsNewSchema = drift.upQueries.filter((entry) =>
      [...NEW_COLUMNS, CHECK_NAME, FK_NAME, INDEX_NAME].some((name) =>
        entry.query.includes(name),
      ),
    );
    expect(mentionsNewSchema).toEqual([]);

    await undoMigrationsThrough(dataSource, MIGRATION_NAME);
    expect(await resolutionColumns()).toEqual([]);
    expect(await constraintNames()).toEqual([]);
    expect(await indexDefinitions()).toHaveLength(0);

    await dataSource.runMigrations();
    expect(await resolutionColumns()).toHaveLength(3);
    expect(await indexDefinitions()).toHaveLength(1);
  });

  it('leaves existing rows untouched and enforces the resolution rules', async () => {
    expectMigrationExists();
    await dataSource.runMigrations();
    await undoMigrationsThrough(dataSource, MIGRATION_NAME);

    const userId = await insertUser('migration-resolver');
    const ownerId = await insertUser('migration-owner');
    const orderId = await insertOrder(ownerId);
    const paymentId = await insertPayment(orderId);
    const processedId = await insertEvent(paymentId, 'processed', 'evt-1');
    const reconcileId = await insertEvent(
      paymentId,
      'requires_reconciliation',
      'evt-2',
    );
    const before = await dataSource.query(
      `SELECT * FROM "payment_events" ORDER BY "id"`,
    );

    await dataSource.runMigrations();

    const after = await dataSource.query<Record<string, unknown>[]>(
      `SELECT * FROM "payment_events" ORDER BY "id"`,
    );
    expect(after).toHaveLength(2);
    for (const [position, row] of after.entries()) {
      for (const column of NEW_COLUMNS) expect(row[column]).toBeNull();
      const { resolvedAt, resolvedByUserId, resolutionNote, ...original } = row;
      void [resolvedAt, resolvedByUserId, resolutionNote];
      expect(original).toEqual(before[position]);
    }

    // resolvedByUserId or a note without resolvedAt breaks the CHECK.
    await expect(
      dataSource.query(
        `UPDATE "payment_events" SET "resolvedByUserId" = $1 WHERE "id" = $2`,
        [userId, reconcileId],
      ),
    ).rejects.toMatchObject({
      driverError: { code: '23514', constraint: CHECK_NAME },
    });
    await expect(
      dataSource.query(
        `UPDATE "payment_events" SET "resolutionNote" = 'orphan note' WHERE "id" = $1`,
        [reconcileId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });

    // A properly resolved event is accepted, and deleting the resolver keeps
    // the history: the user id becomes NULL but resolvedAt stays.
    await dataSource.query(
      `UPDATE "payment_events"
       SET "resolvedAt" = now(), "resolvedByUserId" = $1, "resolutionNote" = 'handled'
       WHERE "id" = $2`,
      [userId, reconcileId],
    );
    await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [userId]);
    const resolved = await dataSource.query<
      { resolvedAt: Date | null; resolvedByUserId: number | null }[]
    >(
      `SELECT "resolvedAt", "resolvedByUserId" FROM "payment_events" WHERE "id" = $1`,
      [reconcileId],
    );
    expect(resolved[0].resolvedAt).not.toBeNull();
    expect(resolved[0].resolvedByUserId).toBeNull();
    expect(processedId).toBeLessThan(reconcileId);

    // Reverting drops only the new schema and keeps every event row.
    await undoMigrationsThrough(dataSource, MIGRATION_NAME);
    expect(await resolutionColumns()).toEqual([]);
    const remaining = await dataSource.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM "payment_events"`,
    );
    expect(remaining[0].count).toBe(2);
    await dataSource.runMigrations();
  });

  async function insertUser(email: string) {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "users" ("email", "password", "role", "createdAt")
       VALUES ($1, 'hash', '${UserRole.USER}', NOW()) RETURNING "id"`,
      [`${email}@example.test`],
    );
    return rows[0].id;
  }

  async function insertOrder(userId: number) {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "orders" ("userId", "totalPrice", "status", "shippingAddress", "createdAt", "updatedAt")
       VALUES ($1, 400000, '${OrderStatus.CANCELLED}', $2, NOW(), NOW())
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

  async function insertPayment(orderId: number) {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', 'fake_payment_migration', 'migration-key-0001', 400000, 'VND', 'cancelled')
       RETURNING "id"`,
      [orderId],
    );
    return rows[0].id;
  }

  async function insertEvent(
    paymentId: number,
    processingStatus: string,
    providerEventId: string,
  ) {
    const rows = await dataSource.query<{ id: number }[]>(
      `INSERT INTO "payment_events"
         ("paymentId", "provider", "providerEventId", "providerPaymentId", "eventType", "processingStatus", "processingMessage")
       VALUES ($1, 'fake', $2, 'fake_payment_migration', 'succeeded', $3, 'seeded before migration')
       RETURNING "id"`,
      [paymentId, providerEventId, processingStatus],
    );
    return rows[0].id;
  }
});
