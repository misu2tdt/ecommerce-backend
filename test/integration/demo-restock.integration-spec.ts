import { DataSource, EntityManager, In } from 'typeorm';
import { Address } from '../../src/addresses/entities/address.entity';
import {
  DEMO_CUSTOMER_EMAIL,
  getSeededVariantStock,
  seedDemoData,
} from '../../src/database/seeds/demo-seed';
import { restockDemoVariants } from '../../src/database/seeds/demo-restock';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { snapshotShippingAddress } from '../../src/orders/shipping-address';
import { Payment } from '../../src/payments/entities/payment.entity';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { User } from '../../src/users/entities/user.entity';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const testOptions = { target: 'test' as const, nodeEnvironment: 'test' };
const productionOptions = {
  target: 'production' as const,
  nodeEnvironment: 'production',
  productionApproval: {
    confirmation: PRODUCTION_DEMO_CONFIRMATION,
    database: 'ecommerce_test',
  },
};

describe('demo restock on isolated PostgreSQL', () => {
  let dataSource: DataSource;
  const seeded = new Map(getSeededVariantStock().map((v) => [v.sku, v.stock]));

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    await seedDemoData(dataSource, { ...testOptions, images: 'none' });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  const variants = () => dataSource.getRepository(ProductVariant);
  const stockOf = async (sku: string) =>
    (await variants().findOneByOrFail({ sku })).stock;
  const setStock = (sku: string, stock: number) =>
    variants().update({ sku }, { stock });

  async function counts() {
    return {
      variants: await variants().count(),
      orders: await dataSource.getRepository(Order).count(),
      items: await dataSource.getRepository(OrderItem).count(),
      payments: await dataSource.getRepository(Payment).count(),
    };
  }

  async function allVariantRows() {
    return variants().find({ order: { id: 'ASC' } });
  }

  // One pending order for one unit of a seeded variant, as a visitor's checkout
  // leaves it (the unit is already taken out of stock).
  async function pendingOrderFor(sku: string, status = OrderStatus.PENDING) {
    const customer = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: DEMO_CUSTOMER_EMAIL });
    const address = await dataSource
      .getRepository(Address)
      .findOneOrFail({ where: { userId: customer.id } });
    const variant = await variants().findOneByOrFail({ sku });
    const order = await dataSource.getRepository(Order).save({
      userId: customer.id,
      subtotalPrice: variant.price,
      discountPrice: 0,
      totalPrice: variant.price,
      couponCode: null,
      couponType: null,
      couponValue: null,
      status,
      shippingAddress: snapshotShippingAddress(address),
    });
    await dataSource.getRepository(OrderItem).save({
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      price: variant.price,
    });
    return order;
  }

  it('raises depleted seeded variants back to their seeded quantities', async () => {
    await setStock('AT-CCT-BLK-M', 0);
    await setStock('KB-CDJ-GRY-M', 3);

    const summary = await restockDemoVariants(dataSource, testOptions);

    expect(await stockOf('AT-CCT-BLK-M')).toBe(seeded.get('AT-CCT-BLK-M'));
    expect(await stockOf('KB-CDJ-GRY-M')).toBe(seeded.get('KB-CDJ-GRY-M'));
    expect(summary).toMatchObject({
      dryRun: false,
      seededVariants: seeded.size,
      changed: 2,
    });
    expect(summary.stockAfter - summary.stockBefore).toBe(
      seeded.get('AT-CCT-BLK-M')! - 0 + (seeded.get('KB-CDJ-GRY-M')! - 3),
    );
    expect(summary.changes.map((change) => change.sku).sort()).toEqual([
      'AT-CCT-BLK-M',
      'KB-CDJ-GRY-M',
    ]);
  });

  it('never lowers stock that is already at or above the seeded quantity', async () => {
    await setStock('AT-CCT-BLK-M', seeded.get('AT-CCT-BLK-M')! + 50);

    const summary = await restockDemoVariants(dataSource, testOptions);

    expect(await stockOf('AT-CCT-BLK-M')).toBe(
      seeded.get('AT-CCT-BLK-M')! + 50,
    );
    expect(summary.changed).toBe(0);
  });

  it('touches only seeded variants and creates or deletes nothing', async () => {
    const extra = await variants().save(
      variants().create({
        productId: (await variants().findOneByOrFail({ sku: 'AT-CCT-BLK-M' }))
          .productId,
        sku: 'ADDED-BY-AN-ADMIN-1',
        name: 'Added by an admin',
        price: 100000,
        stock: 1,
        attributes: {},
        isActive: true,
        position: 99,
      }),
    );
    await setStock('AT-CCT-BLK-M', 0);
    const before = await counts();

    await restockDemoVariants(dataSource, testOptions);

    expect(await counts()).toEqual(before);
    expect(await variants().findOneByOrFail({ id: extra.id })).toMatchObject({
      stock: 1,
    });
  });

  it('leaves orders, items and payments exactly as they are', async () => {
    const order = await pendingOrderFor('AT-CCT-BLK-M');
    await setStock('AT-CCT-BLK-M', 0);
    const ordersBefore = await dataSource
      .getRepository(Order)
      .find({ order: { id: 'ASC' } });
    const itemsBefore = await dataSource
      .getRepository(OrderItem)
      .find({ order: { id: 'ASC' } });
    const paymentsBefore = await dataSource
      .getRepository(Payment)
      .find({ order: { id: 'ASC' } });

    await restockDemoVariants(dataSource, testOptions);

    expect(
      await dataSource.getRepository(Order).find({ order: { id: 'ASC' } }),
    ).toEqual(ordersBefore);
    expect(
      await dataSource.getRepository(OrderItem).find({ order: { id: 'ASC' } }),
    ).toEqual(itemsBefore);
    expect(
      await dataSource.getRepository(Payment).find({ order: { id: 'ASC' } }),
    ).toEqual(paymentsBefore);
    expect(order.id).toBeGreaterThan(0);
  });

  it('keeps a unit reserved by a pending order out of stock, so cancelling it later cannot overshoot', async () => {
    await pendingOrderFor('AT-CCT-BLK-M');
    // A confirmed order has been sold, not reserved.
    await pendingOrderFor('AT-CCT-BLK-M', OrderStatus.CONFIRMED);
    await setStock('AT-CCT-BLK-M', 0);

    const summary = await restockDemoVariants(dataSource, testOptions);

    expect(await stockOf('AT-CCT-BLK-M')).toBe(seeded.get('AT-CCT-BLK-M')! - 1);
    expect(summary.reservedByPendingOrders).toBe(1);
    expect(summary.changes[0]).toMatchObject({
      sku: 'AT-CCT-BLK-M',
      reserved: 1,
    });
  });

  it('is idempotent: a second run changes nothing, not even updatedAt', async () => {
    await setStock('AT-CCT-BLK-M', 0);
    await restockDemoVariants(dataSource, testOptions);
    const afterFirst = await allVariantRows();

    const second = await restockDemoVariants(dataSource, testOptions);

    expect(second.changed).toBe(0);
    expect(second.stockBefore).toBe(second.stockAfter);
    expect(await allVariantRows()).toEqual(afterFirst);
  });

  it('writes nothing in --dry-run but reports what it would do', async () => {
    await setStock('AT-CCT-BLK-M', 0);
    const before = await allVariantRows();

    const summary = await restockDemoVariants(dataSource, {
      ...testOptions,
      dryRun: true,
    });

    expect(summary).toMatchObject({ dryRun: true, changed: 1 });
    expect(summary.stockAfter).toBe(
      summary.stockBefore + seeded.get('AT-CCT-BLK-M')!,
    );
    expect(await allVariantRows()).toEqual(before);
  });

  it('is all or nothing: a failure part-way leaves every variant as it was', async () => {
    await setStock('AT-CCT-BLK-M', 0);
    await setStock('KB-CDJ-GRY-M', 0);
    await setStock('VA-SPT-CHR-M', 0);
    const before = await allVariantRows();

    const original = EntityManager.prototype.update;
    let calls = 0;
    const spy = jest
      .spyOn(EntityManager.prototype, 'update')
      .mockImplementation(function (this: EntityManager, ...args: never[]) {
        calls += 1;
        if (calls === 3) throw new Error('simulated failure');
        return (original as (...a: unknown[]) => Promise<unknown>).apply(
          this,
          args,
        ) as never;
      });
    try {
      await expect(
        restockDemoVariants(dataSource, testOptions),
      ).rejects.toThrow('simulated failure');
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(3);
    expect(await allVariantRows()).toEqual(before);
  });

  describe('guards', () => {
    it('refuses the production target without the production seed approval', async () => {
      await expect(
        restockDemoVariants(dataSource, {
          target: 'production',
          nodeEnvironment: 'production',
        }),
      ).rejects.toThrow(/explicit confirmation/);
      await expect(
        restockDemoVariants(dataSource, {
          ...productionOptions,
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database: 'some_other_database',
          },
        }),
      ).rejects.toThrow(/does not match/);
    });

    it('refuses to run a production restock outside NODE_ENV=production', async () => {
      await expect(
        restockDemoVariants(dataSource, {
          ...productionOptions,
          nodeEnvironment: 'test',
        }),
      ).rejects.toThrow(/NODE_ENV=production/);
    });

    it('refuses reserved databases before touching them', async () => {
      const transaction = jest.fn();
      const reserved = {
        options: {
          database: 'postgres',
          synchronize: false,
          dropSchema: false,
        },
        transaction,
      } as unknown as DataSource;

      await expect(
        restockDemoVariants(reserved, {
          ...productionOptions,
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database: 'postgres',
          },
        }),
      ).rejects.toThrow(/reserved database/);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('allows the production target when approved for exactly this database', async () => {
      await setStock('AT-CCT-BLK-M', 0);

      const summary = await restockDemoVariants(dataSource, productionOptions);

      expect(summary.changed).toBe(1);
      expect(await stockOf('AT-CCT-BLK-M')).toBe(seeded.get('AT-CCT-BLK-M'));
    });

    it('keeps the CHECK stock >= 0 by never producing a negative quantity', async () => {
      // More units pending than were ever seeded: the target floors at zero.
      const order = await pendingOrderFor('AT-CCT-BLK-M');
      await dataSource
        .getRepository(OrderItem)
        .update(
          { orderId: order.id },
          { quantity: seeded.get('AT-CCT-BLK-M')! + 5 },
        );
      await setStock('AT-CCT-BLK-M', 0);

      await restockDemoVariants(dataSource, testOptions);

      expect(await stockOf('AT-CCT-BLK-M')).toBe(0);
      expect(
        (
          await variants().find({ where: { sku: In([...seeded.keys()]) } })
        ).every((variant) => variant.stock >= 0),
      ).toBe(true);
    });
  });
});
