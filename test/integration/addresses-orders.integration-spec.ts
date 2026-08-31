import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { Address } from '../../src/addresses/entities/address.entity';
import { AddressesService } from '../../src/addresses/addresses.service';
import { CartItem } from '../../src/carts/entities/cart-item.entity';
import { CartsService } from '../../src/carts/carts.service';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import { createCategory, createVariant } from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Addresses and Order lifecycle PostgreSQL integration', () => {
  let dataSource: DataSource;
  let addresses: AddressesService;
  let orders: OrdersService;
  let carts: CartsService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    const promotions = new PromotionsService(dataSource);
    addresses = new AddressesService(dataSource);
    orders = new OrdersService(
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

  it('enforces Address ownership and one default per User', async () => {
    const owner = await createUser('address-owner');
    const other = await createUser('address-other');
    const first = await addresses.create(owner.id, addressDto('first', true));
    const second = await addresses.create(owner.id, addressDto('second', true));
    const saved = await addresses.findAll(owner.id);
    expect(saved.map(({ id, isDefault }) => ({ id, isDefault }))).toEqual([
      { id: second.id, isDefault: true },
      { id: first.id, isDefault: false },
    ]);
    await expect(
      addresses.update(other.id, first.id, { city: 'Other City' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(addresses.remove(other.id, first.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await expect(
      dataSource.getRepository(Address).save({
        ...addressDto('third', true),
        userId: owner.id,
        countryCode: 'US',
      }),
    ).rejects.toBeInstanceOf(QueryFailedError);

    await addresses.remove(owner.id, second.id);
    expect(await addresses.findAll(owner.id)).toEqual([
      expect.objectContaining({ id: first.id, isDefault: false }),
    ]);
  });

  it('keeps an immutable shipping snapshot and enforces Order history ownership', async () => {
    const owner = await createUser('snapshot-owner');
    const other = await createUser('snapshot-other');
    const address = await addresses.create(owner.id, addressDto('snapshot'));
    const variant = await setupVariant('snapshot', 5, 200_000);
    const order = await orders.checkout(owner.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 1 }],
    });
    const originalSnapshot = structuredClone(order.shippingAddress);
    await addresses.update(owner.id, address.id, {
      recipientName: 'Changed Recipient',
      city: 'Changed City',
    });
    await addresses.remove(owner.id, address.id);
    const persisted = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: order.id });
    expect(persisted.shippingAddress).toEqual(originalSnapshot);
    expect(await orders.findAllForUser(owner.id)).toEqual([
      expect.objectContaining({ id: order.id }),
    ]);
    await expect(
      orders.findOneForUser(other.id, order.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(orders.findAllForUser(other.id)).resolves.toEqual([]);
  });

  it('restores inventory exactly once under concurrent duplicate cancellation', async () => {
    const user = await createUser('cancel-concurrent');
    const address = await addresses.create(user.id, addressDto('cancel'));
    const variant = await setupVariant('cancel-concurrent', 5, 200_000);
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 2 }],
    });
    expect(await stockOf(variant.id)).toBe(3);
    const results = await Promise.allSettled([
      orders.cancelForUser(user.id, order.id),
      orders.cancelForUser(user.id, order.id),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(await stockOf(variant.id)).toBe(5);
    expect(
      (await dataSource.getRepository(Order).findOneByOrFail({ id: order.id }))
        .status,
    ).toBe(OrderStatus.CANCELLED);
  });

  it('allows only forward admin lifecycle and never restocks normal transitions', async () => {
    const user = await createUser('lifecycle');
    const address = await addresses.create(user.id, addressDto('lifecycle'));
    const variant = await setupVariant('lifecycle', 5, 200_000);
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 2 }],
    });
    await expect(
      orders.updateStatus(order.id, OrderStatus.SHIPPED),
    ).rejects.toBeInstanceOf(BadRequestException);
    await orders.updateStatus(order.id, OrderStatus.CONFIRMED);
    await orders.updateStatus(order.id, OrderStatus.PROCESSING);
    await orders.updateStatus(order.id, OrderStatus.SHIPPED);
    expect(await stockOf(variant.id)).toBe(3);
    await expect(
      orders.updateStatus(order.id, OrderStatus.CANCELLED),
    ).rejects.toBeInstanceOf(BadRequestException);
    await orders.updateStatus(order.id, OrderStatus.DELIVERED);
    await expect(
      orders.updateStatus(order.id, OrderStatus.PROCESSING),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await stockOf(variant.id)).toBe(3);
  });

  it('keeps Address snapshot, Order, stock decrement and Cart clear atomic', async () => {
    const user = await createUser('cart-address');
    const address = await addresses.create(user.id, addressDto('cart'));
    const variant = await setupVariant('cart-address', 4, 300_000);
    await carts.addItem(user.id, { variantId: variant.id, quantity: 2 });
    const order = await carts.checkout(user.id, address.id);
    expect(order.shippingAddress).toEqual(
      expect.objectContaining({ recipientName: 'Recipient cart' }),
    );
    await expect(dataSource.getRepository(CartItem).count()).resolves.toBe(0);
    expect(await stockOf(variant.id)).toBe(2);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(1);
  });

  async function createUser(suffix: string) {
    return dataSource.getRepository(User).save({
      email: `${suffix}@example.test`,
      password: 'hash',
      role: UserRole.USER,
    });
  }

  function addressDto(suffix: string, isDefault = false) {
    return {
      label: null,
      recipientName: `Recipient ${suffix}`,
      phone: '+12025550123',
      addressLine1: `Address ${suffix}`,
      addressLine2: null,
      ward: null,
      district: null,
      city: 'Test City',
      stateProvince: null,
      postalCode: null,
      countryCode: 'us',
      isDefault,
    };
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

  async function stockOf(variantId: number) {
    return (
      await dataSource
        .getRepository(ProductVariant)
        .findOneByOrFail({ id: variantId })
    ).stock;
  }
});
