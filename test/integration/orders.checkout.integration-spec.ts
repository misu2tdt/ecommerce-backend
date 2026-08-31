import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { OrdersService } from '../../src/orders/orders.service';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { Order } from '../../src/orders/entities/order.entity';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { ProductVariantsService } from '../../src/products/product-variants.service';
import { ProductsService } from '../../src/products/products.service';
import { Category } from '../../src/categories/entities/category.entity';
import { Brand } from '../../src/brands/entities/brand.entity';
import { ImageStorageService } from '../../src/image-storage/image-storage.service';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Variant checkout PostgreSQL integration', () => {
  let dataSource: DataSource;
  let sendMessage: jest.Mock;
  let service: OrdersService;
  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });
  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    sendMessage = jest.fn().mockResolvedValue(undefined);
    const promotions = new PromotionsService(dataSource);
    service = new OrdersService(
      dataSource,
      {
        sendMessage,
      } as unknown as TelegramService,
      promotions,
    );
  });
  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('rolls back Variant stock and Order after a later atomic checkout failure', async () => {
    const variant = await setupVariant('rollback', 2, 250_000);
    const user = await dataSource.getRepository(User).save({
      email: 'rollback@example.test',
      password: 'hash',
      role: UserRole.USER,
    });
    const address = await createAddress(dataSource, user, 'rollback');
    const querySpy = jest.spyOn(dataSource.logger, 'logQuery');
    let error: unknown;
    try {
      await service.checkoutPrepared(user.id, async () => ({
        dto: {
          addressId: address.id,
          items: [{ variantId: variant.id, quantity: 1 }],
        },
        afterOrderSaved: async () => {
          throw new Error('Simulated atomic checkout failure');
        },
      }));
    } catch (caught) {
      error = caught;
    }
    const queries = querySpy.mock.calls.map(([query]) => query);
    querySpy.mockRestore();
    expect(error).toEqual(new Error('Simulated atomic checkout failure'));
    expect(
      queries.findIndex((query) =>
        query.startsWith('UPDATE "product_variants"'),
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(
      (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock,
    ).toBe(2);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
  });

  it('allows exactly one overlapping checkout for final Variant unit', async () => {
    const variant = await setupVariant('concurrency', 1, 400_000);
    const users = await dataSource.getRepository(User).save([
      { email: 'a@example.test', password: 'hash', role: UserRole.USER },
      { email: 'b@example.test', password: 'hash', role: UserRole.USER },
    ]);
    const addresses = await Promise.all([
      createAddress(dataSource, users[0], 'concurrency-a'),
      createAddress(dataSource, users[1], 'concurrency-b'),
    ]);
    const blocker = dataSource.createQueryRunner();
    const promises: Array<ReturnType<OrdersService['checkout']>> = [];
    let results: PromiseSettledResult<
      Awaited<ReturnType<OrdersService['checkout']>>
    >[] = [];
    try {
      await blocker.connect();
      await blocker.startTransaction();
      await blocker.manager.getRepository(ProductVariant).findOneOrFail({
        where: { id: variant.id },
        lock: { mode: 'pessimistic_write' },
      });
      promises.push(
        service.checkout(users[0].id, {
          addressId: addresses[0].id,
          items: [{ variantId: variant.id, quantity: 1 }],
        }),
        service.checkout(users[1].id, {
          addressId: addresses[1].id,
          items: [{ variantId: variant.id, quantity: 1 }],
        }),
      );
      expect(
        await waitForVariantLockWaiters(blocker, 2),
      ).toBeGreaterThanOrEqual(2);
      await blocker.commitTransaction();
      results = await Promise.allSettled(promises);
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await Promise.allSettled(promises);
    }
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    expect(
      (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock,
    ).toBe(0);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(1);
    await expect(dataSource.getRepository(OrderItem).count()).resolves.toBe(1);
  }, 15_000);

  it('protects ordered Variant and Product history from hard delete', async () => {
    const variant = await setupVariant('history', 2, 100_000);
    const user = await dataSource.getRepository(User).save({
      email: 'history@example.test',
      password: 'hash',
      role: UserRole.USER,
    });
    const address = await createAddress(dataSource, user, 'history');
    await service.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 1 }],
    });
    const variants = new ProductVariantsService(
      dataSource.getRepository(ProductVariant),
      dataSource.getRepository(Product),
    );
    await expect(
      variants.removeForProduct(variant.productId, variant.id),
    ).rejects.toBeInstanceOf(ConflictException);
    const image = await dataSource.getRepository(ProductImage).save({
      productId: variant.productId,
      url: 'https://example.test/history.jpg',
      storageKey: 'history-key',
      altText: null,
      position: 0,
      isPrimary: false,
    });
    const storage = { deleteImage: jest.fn() };
    const products = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(Category),
      dataSource.getRepository(Brand),
      dataSource.getRepository(ProductImage),
      storage as unknown as ImageStorageService,
    );
    await expect(products.remove(variant.productId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(storage.deleteImage).not.toHaveBeenCalled();
    await expect(
      dataSource.getRepository(ProductImage).findOneBy({ id: image.id }),
    ).resolves.not.toBeNull();
  });

  async function setupVariant(suffix: string, stock: number, price: number) {
    const category = await createCategory(dataSource, suffix);
    const product = await dataSource.getRepository(Product).save({
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      description: null,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: null,
    });
    return createVariant(dataSource, product, suffix, { stock, price });
  }
});

async function waitForVariantLockWaiters(
  observer: QueryRunner,
  expected: number,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const [row] = await observer.query(
      `SELECT COUNT(*) FILTER (WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%' AND query LIKE '%"product_variants"%')::int AS waiters FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    if (row.waiters >= expected) return row.waiters;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Expected Variant checkout lock waiters');
}
