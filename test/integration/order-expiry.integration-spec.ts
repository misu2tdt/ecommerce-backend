import { ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrderExpiryService } from '../../src/orders/order-expiry.service';
import { OrdersService } from '../../src/orders/orders.service';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../../src/payments/entities/payment-event-type.enum';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
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

const MINUTE = 60_000;
const STOCK = 5;
const QUANTITY = 2;

// The default payment window is 30 minutes, so "31 minutes from now" makes an
// order created just now overdue without touching its stored timestamps.
const afterWindow = () => new Date(Date.now() + 31 * MINUTE);

describe('Order expiry (PostgreSQL)', () => {
  let dataSource: DataSource;
  let provider: FakePaymentProvider;
  let payments: PaymentsService;
  let orders: OrdersService;
  let expiry: OrderExpiryService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    provider = new FakePaymentProvider();
    payments = new PaymentsService(dataSource, provider, 'VND');
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      new PromotionsService(dataSource),
    );
    expiry = new OrderExpiryService(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('cancels an overdue pending Order, restores stock once and cancels its unfinished payments', async () => {
    const processing = await checkout('expire-processing');
    const created = await payments.createForOrder(
      processing.user.id,
      processing.order.id,
      'expire-processing-key',
    );
    expect(created.status).toBe(PaymentStatus.PROCESSING);
    const pending = await checkout('expire-pending');
    await insertPayment(pending.order.id, 'expire-pending-key', 'pending');
    expect(await stockOf(processing.variant.id)).toBe(STOCK - QUANTITY);

    const result = await expiry.expireOverdueOrders(afterWindow());

    expect(result).toEqual({ scanned: 2, expired: 2, skipped: 0, failed: 0 });
    for (const fixture of [processing, pending]) {
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CANCELLED,
      );
      expect(await stockOf(fixture.variant.id)).toBe(STOCK);
    }
    expect((await paymentOf(created.id)).status).toBe(PaymentStatus.CANCELLED);
    expect(
      (
        await dataSource
          .getRepository(Payment)
          .findOneByOrFail({ idempotencyKey: 'expire-pending-key' })
      ).status,
    ).toBe(PaymentStatus.CANCELLED);
  });

  it('leaves a fresh pending Order untouched', async () => {
    const fresh = await checkout('fresh');

    const result = await expiry.expireOverdueOrders(new Date());

    expect(result).toEqual({ scanned: 0, expired: 0, skipped: 0, failed: 0 });
    expect((await orderOf(fresh.order.id)).status).toBe(OrderStatus.PENDING);
    expect(await stockOf(fresh.variant.id)).toBe(STOCK - QUANTITY);
  });

  it('skips confirmed Orders and overdue Orders that already have a succeeded payment', async () => {
    const confirmed = await checkout('confirmed');
    await dataSource.query(
      `UPDATE "orders" SET "status" = 'confirmed' WHERE "id" = $1`,
      [confirmed.order.id],
    );
    const paid = await checkout('paid-but-pending');
    await insertPayment(paid.order.id, 'paid-key-0000001', 'succeeded');
    const abandoned = await checkout('abandoned');

    const result = await expiry.expireOverdueOrders(afterWindow());

    expect(result).toEqual({ scanned: 2, expired: 1, skipped: 1, failed: 0 });
    expect((await orderOf(abandoned.order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect((await orderOf(confirmed.order.id)).status).toBe(
      OrderStatus.CONFIRMED,
    );
    expect((await orderOf(paid.order.id)).status).toBe(OrderStatus.PENDING);
    expect(await stockOf(confirmed.variant.id)).toBe(STOCK - QUANTITY);
    expect(await stockOf(paid.variant.id)).toBe(STOCK - QUANTITY);
  });

  it('is idempotent: a second sweep changes nothing and stock is restored once', async () => {
    const fixture = await checkout('idempotent');

    const first = await expiry.expireOverdueOrders(afterWindow());
    const second = await expiry.expireOverdueOrders(afterWindow());

    expect(first.expired).toBe(1);
    expect(second).toEqual({ scanned: 0, expired: 0, skipped: 0, failed: 0 });
    expect(await stockOf(fixture.variant.id)).toBe(STOCK);
  });

  it('is safe when two sweeps run at the same time', async () => {
    const withPayment = await checkout('concurrent-with-payment');
    await payments.createForOrder(
      withPayment.user.id,
      withPayment.order.id,
      'concurrent-expire-key',
    );
    const withoutPayment = await checkout('concurrent-without-payment');
    const later = afterWindow();

    const results = await Promise.all([
      expiry.expireOverdueOrders(later),
      new OrderExpiryService(dataSource).expireOverdueOrders(later),
    ]);

    expect(results.reduce((sum, item) => sum + item.expired, 0)).toBe(2);
    expect(results.reduce((sum, item) => sum + item.failed, 0)).toBe(0);
    for (const fixture of [withPayment, withoutPayment]) {
      expect((await orderOf(fixture.order.id)).status).toBe(
        OrderStatus.CANCELLED,
      );
      expect(await stockOf(fixture.variant.id)).toBe(STOCK);
    }
  });

  it('keeps going when one Order fails and reports it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const first = await checkout('batch-first');
    const broken = await checkout('batch-broken');
    const last = await checkout('batch-last');
    const internals = expiry as unknown as {
      expireOne: (orderId: number, cutoff: Date) => Promise<string>;
    };
    const original = internals.expireOne.bind(expiry);
    jest
      .spyOn(internals, 'expireOne')
      .mockImplementation((orderId, cutoff) =>
        orderId === broken.order.id
          ? Promise.reject(new Error('simulated failure'))
          : original(orderId, cutoff),
      );

    const result = await expiry.expireOverdueOrders(afterWindow());

    expect(result).toEqual({ scanned: 3, expired: 2, skipped: 0, failed: 1 });
    expect((await orderOf(first.order.id)).status).toBe(OrderStatus.CANCELLED);
    expect((await orderOf(last.order.id)).status).toBe(OrderStatus.CANCELLED);
    expect((await orderOf(broken.order.id)).status).toBe(OrderStatus.PENDING);
    expect(await stockOf(broken.variant.id)).toBe(STOCK - QUANTITY);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('processes at most batchSize Orders per sweep, lowest id first', async () => {
    const one = await checkout('batch-limit-1');
    const two = await checkout('batch-limit-2');
    const three = await checkout('batch-limit-3');

    const firstSweep = await expiry.expireOverdueOrders(afterWindow(), 2);

    expect(firstSweep).toEqual({
      scanned: 2,
      expired: 2,
      skipped: 0,
      failed: 0,
    });
    expect((await orderOf(one.order.id)).status).toBe(OrderStatus.CANCELLED);
    expect((await orderOf(two.order.id)).status).toBe(OrderStatus.CANCELLED);
    expect((await orderOf(three.order.id)).status).toBe(OrderStatus.PENDING);

    const secondSweep = await expiry.expireOverdueOrders(afterWindow(), 2);
    expect(secondSweep.expired).toBe(1);
  });

  it('honours a custom payment window', async () => {
    const fixture = await checkout('custom-window');
    const sixtyMinutes = new OrderExpiryService(dataSource, 60);

    const early = await sixtyMinutes.expireOverdueOrders(afterWindow());
    expect(early.scanned).toBe(0);
    expect((await orderOf(fixture.order.id)).status).toBe(OrderStatus.PENDING);

    const late = await sixtyMinutes.expireOverdueOrders(
      new Date(Date.now() + 61 * MINUTE),
    );
    expect(late.expired).toBe(1);
  });

  it('answers the existing "Only a pending Order can be paid" conflict after expiry', async () => {
    const fixture = await checkout('pay-after-expiry');
    await expiry.expireOverdueOrders(afterWindow());

    const failure = await payments
      .createForOrder(fixture.user.id, fixture.order.id, 'pay-after-expiry-key')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).message).toBe(
      'Only a pending Order can be paid',
    );
  });

  it('keeps a late success IPN for reconciliation and does not touch the cancelled Order', async () => {
    const fixture = await checkout('late-ipn');
    const created = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'late-ipn-key-0001',
    );
    const stored = await paymentOf(created.id);
    await expiry.expireOverdueOrders(afterWindow());

    const outcome = await payments.processEvent({
      provider: stored.provider,
      providerEventId: 'late-success-event',
      providerPaymentId: stored.providerPaymentId!,
      eventType: PaymentEventType.SUCCEEDED,
    });

    expect(outcome.event.processingStatus).toBe(
      PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
    );
    expect((await orderOf(fixture.order.id)).status).toBe(
      OrderStatus.CANCELLED,
    );
    expect((await paymentOf(created.id)).status).toBe(PaymentStatus.CANCELLED);
    expect(await stockOf(fixture.variant.id)).toBe(STOCK);
  });

  it('exposes paymentExpiresAt for PENDING Orders only, on user and admin views', async () => {
    const pending = await checkout('view-pending');
    const cancelled = await checkout('view-cancelled');
    await orders.cancelForUser(cancelled.user.id, cancelled.order.id);

    const userView = await orders.findOneForUser(
      pending.user.id,
      pending.order.id,
    );
    const adminView = await orders.findOneForAdmin(pending.order.id);
    const listed = await orders.findAllForUser(pending.user.id);

    for (const view of [userView, adminView, listed[0]]) {
      expect(view.paymentExpiresAt).toBeInstanceOf(Date);
      expect(view.paymentExpiresAt!.getTime() - view.createdAt.getTime()).toBe(
        30 * MINUTE,
      );
    }
    expect(
      (await orders.findOneForAdmin(cancelled.order.id)).paymentExpiresAt,
    ).toBeNull();

    const hour = new OrdersService(
      dataSource,
      { sendMessage: jest.fn() } as unknown as TelegramService,
      new PromotionsService(dataSource),
      60,
    );
    const hourView = await hour.findOneForAdmin(pending.order.id);
    expect(
      hourView.paymentExpiresAt!.getTime() - hourView.createdAt.getTime(),
    ).toBe(60 * MINUTE);
  });

  async function checkout(suffix: string) {
    const user = await dataSource.getRepository(User).save({
      email: `${suffix}@order-expiry.test`,
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

  function insertPayment(orderId: number, key: string, status: string) {
    return dataSource.query(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', NULL, $2, 400000, 'VND', $3)`,
      [orderId, key, status],
    );
  }

  function orderOf(id: number) {
    return dataSource.getRepository(Order).findOneByOrFail({ id });
  }

  function paymentOf(id: number) {
    return dataSource.getRepository(Payment).findOneByOrFail({ id });
  }

  async function stockOf(id: number) {
    return (
      await dataSource.getRepository(ProductVariant).findOneByOrFail({ id })
    ).stock;
  }
});
