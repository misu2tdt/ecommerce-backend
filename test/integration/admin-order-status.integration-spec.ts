import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import { PaymentEventType } from '../../src/payments/entities/payment-event-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { FakePaymentProvider } from '../../src/payments/fake-payment.provider';
import { PaymentsService } from '../../src/payments/payments.service';
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

const STOCK = 5;
const QUANTITY = 2;

describe('Admin order status changes (PostgreSQL)', () => {
  let dataSource: DataSource;
  let payments: PaymentsService;
  let orders: OrdersService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    payments = new PaymentsService(
      dataSource,
      new FakePaymentProvider(),
      'VND',
    );
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      new PromotionsService(dataSource),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('refuses to confirm a pending Order: only a successful payment confirms', async () => {
    const { order } = await checkout('admin-confirm');

    const failure = await orders
      .updateStatus(order.id, OrderStatus.CONFIRMED)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).message).toBe(
      'An Order is confirmed only by a successful payment',
    );
    expect(await statusOf(order.id)).toBe(OrderStatus.PENDING);
  });

  it.each([
    ['confirmed', OrderStatus.PROCESSING],
    ['processing', OrderStatus.SHIPPED],
    ['shipped', OrderStatus.DELIVERED],
  ])(
    'refuses to move a %s Order to %s without a succeeded payment',
    async (current, target) => {
      const { order } = await checkout(`no-payment-${current}`);
      await dataSource.query(
        `UPDATE "orders" SET "status" = $1 WHERE "id" = $2`,
        [current, order.id],
      );

      const failure = await orders
        .updateStatus(order.id, target)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).message).toBe(
        'Order has no successful payment',
      );
      expect(await statusOf(order.id)).toBe(current);
    },
  );

  it('does not count failed or cancelled payments as paid', async () => {
    const { order } = await checkout('unpaid-attempts');
    await dataSource.query(
      `INSERT INTO "payments" ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', NULL, 'unpaid-attempt-failed', 400000, 'VND', 'failed'),
              ($1, 'fake', NULL, 'unpaid-attempt-cancelled', 400000, 'VND', 'cancelled')`,
      [order.id],
    );
    await dataSource.query(
      `UPDATE "orders" SET "status" = 'confirmed' WHERE "id" = $1`,
      [order.id],
    );

    await expect(
      orders.updateStatus(order.id, OrderStatus.PROCESSING),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('moves a paid Order through processing, shipped and delivered', async () => {
    const { user, order, variant } = await checkout('paid-lifecycle');
    const created = await payments.createForOrder(
      user.id,
      order.id,
      'paid-lifecycle-key',
    );
    const stored = await dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: created.id });
    await payments.processEvent({
      provider: stored.provider,
      providerEventId: 'paid-lifecycle-event',
      providerPaymentId: stored.providerPaymentId!,
      eventType: PaymentEventType.SUCCEEDED,
    });
    expect(await statusOf(order.id)).toBe(OrderStatus.CONFIRMED);

    await orders.updateStatus(order.id, OrderStatus.PROCESSING);
    await orders.updateStatus(order.id, OrderStatus.SHIPPED);
    await orders.updateStatus(order.id, OrderStatus.DELIVERED);

    expect(await statusOf(order.id)).toBe(OrderStatus.DELIVERED);
    expect(await stockOf(variant.id)).toBe(STOCK - QUANTITY);
  });

  it('keeps invalid transitions at 400, even for a paid Order', async () => {
    const { order } = await checkout('invalid-transition');
    await expect(
      orders.updateStatus(order.id, OrderStatus.SHIPPED),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves cancellation through updateStatus unchanged', async () => {
    const unpaid = await checkout('cancel-unpaid');
    const paid = await checkout('cancel-paid');
    await dataSource.query(
      `INSERT INTO "payments" ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', NULL, 'cancel-paid-key-0001', 400000, 'VND', 'succeeded')`,
      [paid.order.id],
    );
    await dataSource.query(
      `UPDATE "orders" SET "status" = 'confirmed' WHERE "id" = $1`,
      [paid.order.id],
    );

    await orders.updateStatus(unpaid.order.id, OrderStatus.CANCELLED);
    expect(await statusOf(unpaid.order.id)).toBe(OrderStatus.CANCELLED);
    expect(await stockOf(unpaid.variant.id)).toBe(STOCK);

    await expect(
      orders.updateStatus(paid.order.id, OrderStatus.CANCELLED),
    ).rejects.toThrow('Paid Order cannot be cancelled before refund support');
    expect(await statusOf(paid.order.id)).toBe(OrderStatus.CONFIRMED);
  });

  async function checkout(suffix: string) {
    const user = await dataSource.getRepository(User).save({
      email: `${suffix}@admin-status.test`,
      password: 'hash',
      role: UserRole.USER,
    });
    const address = await createAddress(dataSource, user, suffix);
    const category = await createCategory(dataSource, suffix);
    const product = await dataSource.getRepository(Product).save({
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      description: null,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: null,
    });
    const variant = await createVariant(dataSource, product, suffix, {
      price: 200_000,
      stock: STOCK,
    });
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: QUANTITY }],
    });
    return { user, variant, order };
  }

  async function statusOf(id: number) {
    return (await dataSource.getRepository(Order).findOneByOrFail({ id }))
      .status;
  }

  async function stockOf(id: number) {
    return (
      await dataSource.getRepository(ProductVariant).findOneByOrFail({ id })
    ).stock;
  }
});
