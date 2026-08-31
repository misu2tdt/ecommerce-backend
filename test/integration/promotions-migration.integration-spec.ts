import { DataSource } from 'typeorm';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Promotions Migration Scenarios (Fresh & Populated Backfill)', () => {
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

  it('Scenario A: Fresh database from migration 1 through 6E completes cleanly with 0 pending', async () => {
    // 1. Reset schema to pure empty state
    await dataSource.query('DROP SCHEMA public CASCADE;');
    await dataSource.query('CREATE SCHEMA public;');

    // 2. Run full TypeORM migration chain from 1 through 6E
    const appliedMigrations = await dataSource.runMigrations();
    expect(appliedMigrations.length).toBeGreaterThanOrEqual(1);

    // 3. Inspect ProductVariant: compareAtPrice exists, nullable, bigint
    const variantColumns = await dataSource.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'product_variants' AND column_name = 'compareAtPrice';
    `);
    expect(variantColumns).toHaveLength(1);
    expect(variantColumns[0].data_type).toBe('bigint');
    expect(variantColumns[0].is_nullable).toBe('YES');

    // 4. Inspect Order: snapshot and promotion columns
    const orderColumns = await dataSource.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'orders'
      ORDER BY ordinal_position;
    `);
    interface ColumnInfo {
      column_name: string;
      data_type: string;
      is_nullable: string;
    }
    const colMap = new Map<string, ColumnInfo>(
      orderColumns.map((c: ColumnInfo) => [c.column_name, c]),
    );

    expect(colMap.has('subtotalPrice')).toBe(true);
    expect(colMap.get('subtotalPrice')?.data_type).toBe('bigint');
    expect(colMap.get('subtotalPrice')?.is_nullable).toBe('NO');

    expect(colMap.has('discountPrice')).toBe(true);
    expect(colMap.get('discountPrice')?.data_type).toBe('bigint');
    expect(colMap.get('discountPrice')?.is_nullable).toBe('NO');

    expect(colMap.has('couponCode')).toBe(true);
    expect(colMap.get('couponCode')?.is_nullable).toBe('YES');

    expect(colMap.has('couponType')).toBe(true);
    expect(colMap.get('couponType')?.is_nullable).toBe('YES');

    expect(colMap.has('couponValue')).toBe(true);
    expect(colMap.get('couponValue')?.data_type).toBe('bigint');
    expect(colMap.get('couponValue')?.is_nullable).toBe('YES');

    // 5. Inspect Coupon table: critical fields exist
    const couponColumns = await dataSource.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'coupons'
      ORDER BY ordinal_position;
    `);
    const couponColNames = couponColumns.map(
      (c: { column_name: string }) => c.column_name,
    );
    expect(couponColNames).toEqual(
      expect.arrayContaining([
        'id',
        'code',
        'name',
        'type',
        'value',
        'minSubtotal',
        'maxDiscount',
        'startsAt',
        'endsAt',
        'isActive',
        'createdAt',
        'updatedAt',
      ]),
    );

    // 6. Inspect check constraints
    const constraints = await dataSource.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'CHK_coupons_max_discount',
        'CHK_coupons_type',
        'CHK_coupons_value',
        'CHK_orders_subtotal_price',
        'CHK_orders_discount_price',
        'CHK_product_variants_compare_at_price'
      );
    `);
    const constraintNames = constraints.map(
      (c: { conname: string }) => c.conname,
    );
    expect(constraintNames).toContain('CHK_coupons_max_discount');
    expect(constraintNames).toContain('CHK_orders_subtotal_price');
    expect(constraintNames).toContain('CHK_orders_discount_price');
    expect(constraintNames).toContain('CHK_product_variants_compare_at_price');

    // 7. Verify TypeORM reports 0 pending migrations
    const hasPending = await dataSource.showMigrations();
    expect(hasPending).toBe(false);
  });

  it('Scenario B: Populated pre-6E schema upgrade backfills subtotalPrice=totalPrice and discountPrice=0', async () => {
    // 1. Undo the Phase 6E migration to represent the exact pre-6E schema
    await dataSource.undoLastMigration();

    // 2. Verify before migration that compareAtPrice does not exist
    const preVariantCols = await dataSource.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'product_variants' AND column_name = 'compareAtPrice';
    `);
    expect(preVariantCols).toHaveLength(0);

    // 3. Insert representative legacy entities: User, Category, Brand, Product, ProductVariant, Order, OrderItem
    const userRes = await dataSource.query(`
      INSERT INTO "users" ("email", "password", "role", "createdAt")
      VALUES ('legacy-user@example.test', 'hash', '${UserRole.USER}', NOW())
      RETURNING "id";
    `);
    const userId = userRes[0].id;

    const catRes = await dataSource.query(`
      INSERT INTO "categories" ("name", "slug", "createdAt", "updatedAt")
      VALUES ('Legacy Tops', 'legacy-tops', NOW(), NOW())
      RETURNING "id";
    `);
    const categoryId = catRes[0].id;

    const brandRes = await dataSource.query(`
      INSERT INTO "brands" ("name", "slug", "createdAt", "updatedAt")
      VALUES ('Legacy Brand', 'legacy-brand', NOW(), NOW())
      RETURNING "id";
    `);
    const brandId = brandRes[0].id;

    const prodRes = await dataSource.query(`
      INSERT INTO "products" ("name", "slug", "categoryId", "brandId", "status", "createdAt", "updatedAt")
      VALUES ('Legacy Tee', 'legacy-tee', ${categoryId}, ${brandId}, '${ProductStatus.ACTIVE}', NOW(), NOW())
      RETURNING "id";
    `);
    const productId = prodRes[0].id;

    const varRes = await dataSource.query(`
      INSERT INTO "product_variants" ("productId", "sku", "name", "price", "stock", "isActive", "createdAt", "updatedAt")
      VALUES (${productId}, 'LEGACY-SKU-1', 'Legacy M', 500000, 10, true, NOW(), NOW())
      RETURNING "id";
    `);
    const variantId = varRes[0].id;

    const knownTotalPrice = 500000;
    const orderRes = await dataSource.query(`
      INSERT INTO "orders" ("userId", "totalPrice", "status", "shippingAddress", "createdAt", "updatedAt")
      VALUES (
        ${userId},
        ${knownTotalPrice},
        '${OrderStatus.PENDING}',
        '${JSON.stringify({
          recipientName: 'Legacy Recipient',
          phone: '+84900000000',
          addressLine1: '123 Legacy St',
          city: 'HCMC',
          countryCode: 'VN',
        })}',
        NOW(),
        NOW()
      )
      RETURNING "id";
    `);
    const orderId = orderRes[0].id;

    await dataSource.query(`
      INSERT INTO "order_items" ("orderId", "variantId", "quantity", "price")
      VALUES (${orderId}, ${variantId}, 1, 500000);
    `);

    // Verify pre-migration order state
    const preOrder = await dataSource.query(
      `SELECT "totalPrice" FROM "orders" WHERE "id" = $1;`,
      [orderId],
    );
    expect(Number(preOrder[0].totalPrice)).toBe(knownTotalPrice);

    // 4. Run the Phase 6E migration through TypeORM migration runner
    await dataSource.runMigrations();

    // 5. Assert backfilled Order values and financial invariant integrity
    const postOrder = await dataSource.query(
      `SELECT * FROM "orders" WHERE "id" = $1;`,
      [orderId],
    );
    expect(postOrder).toHaveLength(1);
    const row = postOrder[0];
    expect(Number(row.subtotalPrice)).toBe(knownTotalPrice);
    expect(Number(row.discountPrice)).toBe(0);
    expect(Number(row.totalPrice)).toBe(knownTotalPrice);
    expect(row.couponCode).toBeNull();
    expect(row.couponType).toBeNull();
    expect(row.couponValue).toBeNull();

    // 6. Assert ProductVariant compareAtPrice is null
    const postVariant = await dataSource.query(
      `SELECT "compareAtPrice" FROM "product_variants" WHERE "id" = $1;`,
      [variantId],
    );
    expect(postVariant[0].compareAtPrice).toBeNull();

    // 7. Assert coupons table exists
    const postCoupons = await dataSource.query(`
      SELECT count(*) FROM information_schema.tables WHERE table_name = 'coupons';
    `);
    expect(Number(postCoupons[0].count)).toBe(1);

    // 8. Verify migration history recognizes Phase 6E as applied (0 pending)
    const hasPending = await dataSource.showMigrations();
    expect(hasPending).toBe(false);
  });
});
