import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { CartItem } from '../../src/carts/entities/cart-item.entity';
import { Cart } from '../../src/carts/entities/cart.entity';
import { CartsService } from '../../src/carts/carts.service';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
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

describe('Shopping cart PostgreSQL integration', () => {
  let dataSource: DataSource;
  let carts: CartsService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    const promotions = new PromotionsService(dataSource);
    const orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      promotions,
    );
    carts = new CartsService(dataSource, orders, promotions);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('enforces one Cart per User at the database boundary', async () => {
    const user = await createUser('one-cart');
    const [first, second] = await Promise.all([
      carts.getCart(user.id),
      carts.getCart(user.id),
    ]);
    expect(first.id).toBe(second.id);
    await expect(dataSource.getRepository(Cart).count()).resolves.toBe(1);
    await expect(
      dataSource.getRepository(Cart).save({ userId: user.id }),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('atomically increments concurrent adds without reserving Variant stock', async () => {
    const user = await createUser('concurrent-add');
    const variant = await setupVariant('concurrent-add', 3, 190_000);
    await Promise.all([
      carts.addItem(user.id, { variantId: variant.id, quantity: 2 }),
      carts.addItem(user.id, { variantId: variant.id, quantity: 4 }),
    ]);
    const items = await dataSource.getRepository(CartItem).find();
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(6);
    expect(
      (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock,
    ).toBe(3);
    const cart = await dataSource.getRepository(Cart).findOneByOrFail({
      userId: user.id,
    });
    await expect(
      dataSource.getRepository(CartItem).save({
        cartId: cart.id,
        variantId: variant.id,
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('returns current Variant price, stock, totals and availability', async () => {
    const user = await createUser('current-values');
    const variant = await setupVariant('current-values', 4, 100_000);
    await carts.addItem(user.id, { variantId: variant.id, quantity: 3 });
    await dataSource.getRepository(ProductVariant).update(variant.id, {
      price: 125_000,
      stock: 2,
    });
    const result = await carts.getCart(user.id);
    expect(result.totalPrice).toBe(375_000);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ lineTotal: 375_000, available: false }),
    );
    expect(result.items[0].variant).toEqual(
      expect.objectContaining({ price: 125_000, stock: 2 }),
    );
  });

  it('checks out through the existing Variant lock path and atomically empties Cart', async () => {
    const user = await createUser('checkout-success');
    const address = await createAddress(dataSource, user, 'checkout-success');
    const variant = await setupVariant('checkout-success', 5, 150_000);
    await carts.addItem(user.id, { variantId: variant.id, quantity: 2 });
    const querySpy = jest.spyOn(dataSource.logger, 'logQuery');
    const order = await carts.checkout(user.id, address.id);
    const queries = querySpy.mock.calls.map(([query]) => query);
    querySpy.mockRestore();
    expect(
      queries.some(
        (query) =>
          query.includes('"product_variants"') && query.includes('FOR UPDATE'),
      ),
    ).toBe(true);
    expect(order.totalPrice).toBe(300_000);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(1);
    await expect(dataSource.getRepository(OrderItem).count()).resolves.toBe(1);
    await expect(dataSource.getRepository(CartItem).count()).resolves.toBe(0);
    expect(
      (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock,
    ).toBe(3);
  });

  it('rolls back stock and Order while preserving Cart on insufficient stock', async () => {
    const user = await createUser('checkout-failure');
    const address = await createAddress(dataSource, user, 'checkout-failure');
    const variant = await setupVariant('checkout-failure', 1, 150_000);
    await carts.addItem(user.id, { variantId: variant.id, quantity: 2 });
    await expect(carts.checkout(user.id, address.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
    await expect(dataSource.getRepository(CartItem).count()).resolves.toBe(1);
    expect(
      (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock,
    ).toBe(1);
  });

  it('returns 404 when a user tries to mutate another user CartItem', async () => {
    const owner = await createUser('owner');
    const other = await createUser('other');
    const variant = await setupVariant('ownership', 5, 150_000);
    const ownerCart = await carts.addItem(owner.id, {
      variantId: variant.id,
      quantity: 1,
    });
    const itemId = ownerCart.items[0].id;
    await expect(
      carts.updateItem(other.id, itemId, { quantity: 2 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(carts.removeItem(other.id, itemId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await carts.getCart(owner.id)).items[0].quantity).toBe(1);
  });

  async function createUser(suffix: string) {
    return dataSource.getRepository(User).save({
      email: `${suffix}@example.test`,
      password: 'hash',
      role: UserRole.USER,
    });
  }

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
