import { BadGatewayException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../../src/payments/entities/payment-event-type.enum';
import { PaymentEvent } from '../../src/payments/entities/payment-event.entity';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { FakePaymentProvider } from '../../src/payments/fake-payment.provider';
import { PaymentsService } from '../../src/payments/payments.service';
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
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Payments PostgreSQL integration', () => {
  let dataSource: DataSource;
  let provider: FakePaymentProvider;
  let payments: PaymentsService;
  let orders: OrdersService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    provider = new FakePaymentProvider();
    payments = new PaymentsService(dataSource, provider, 'VND');
    const promotions = new PromotionsService(dataSource);
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
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

  it('owns Payment through Order and derives amount/currency on the backend', async () => {
    const fixture = await checkout('ownership');
    const other = await createUser('ownership-other');
    const result = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'ownership-key-001',
    );

    expect(result).toEqual(
      expect.objectContaining({
        amount: 400_000,
        currency: 'VND',
        status: PaymentStatus.PROCESSING,
      }),
    );
    const stored = await dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: result.id });
    expect(stored.orderId).toBe(fixture.order.id);
    await expect(
      payments.createForOrder(other.id, fixture.order.id, 'ownership-key-002'),
    ).rejects.toThrow();
  });

  it('deduplicates sequential and concurrent same-key creation including provider work', async () => {
    const fixture = await checkout('idempotency');
    const first = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'same-key-sequential',
    );
    const repeated = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      'same-key-sequential',
    );
    expect(repeated.id).toBe(first.id);
    expect(provider.creationCount).toBe(1);

    const secondFixture = await checkout('idempotency-concurrent');
    const concurrent = await Promise.all([
      payments.createForOrder(
        secondFixture.user.id,
        secondFixture.order.id,
        'same-key-concurrent',
      ),
      payments.createForOrder(
        secondFixture.user.id,
        secondFixture.order.id,
        'same-key-concurrent',
      ),
    ]);
    expect(new Set(concurrent.map(({ id }) => id))).toEqual(
      new Set([concurrent[0].id]),
    );
    expect(
      await dataSource
        .getRepository(Payment)
        .countBy({ idempotencyKey: 'same-key-concurrent' }),
    ).toBe(1);
    expect(provider.creationCount).toBe(2);
  });

  it('processes success once, confirms Order and does not change stock', async () => {
    const fixture = await checkout('success');
    const created = await createPayment(fixture, 'success-create-key');
    const stockAfterCheckout = await stockOf(fixture.variant.id);
    const event = providerEvent(created, 'success-event-001', 'succeeded');

    const first = await payments.processEvent(event);
    const duplicate = await payments.processEvent(event);

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect((await paymentOf(created.id)).status).toBe(PaymentStatus.SUCCEEDED);
    expect((await orderOf(fixture.order.id)).status).toBe(
      OrderStatus.CONFIRMED,
    );
    expect(await stockOf(fixture.variant.id)).toBe(stockAfterCheckout);
    expect(await dataSource.getRepository(PaymentEvent).count()).toBe(1);
    await expect(
      payments.createForOrder(
        fixture.user.id,
        fixture.order.id,
        'already-paid-key',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('records provider creation/event failures safely and leaves Order pending', async () => {
    const failedCreationFixture = await checkout('provider-create-failure');
    provider.failNextCreation();
    await expect(
      payments.createForOrder(
        failedCreationFixture.user.id,
        failedCreationFixture.order.id,
        'provider-failure-key',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    const failedCreation = await dataSource
      .getRepository(Payment)
      .findOneByOrFail({ idempotencyKey: 'provider-failure-key' });
    expect(failedCreation.status).toBe(PaymentStatus.FAILED);
    expect(failedCreation.failureMessage).toBe(
      'Provider payment creation failed',
    );

    const fixture = await checkout('failure-event');
    const created = await createPayment(fixture, 'failure-event-key');
    await payments.processEvent({
      ...providerEvent(created, 'failure-event-001', 'failed'),
      failureCode: ' DECLINED\nunsafe ',
      failureMessage: ' Payment\tdeclined\nby provider ',
    });
    const stored = await paymentOf(created.id);
    expect(stored.status).toBe(PaymentStatus.FAILED);
    expect(stored.failureCode).toBe('DECLINED unsafe');
    expect(stored.failureMessage).toBe('Payment declined by provider');
    expect((await orderOf(fixture.order.id)).status).toBe(OrderStatus.PENDING);
  });

  it('rejects paid cancellation, retains unpaid restock, and preserves the race invariant', async () => {
    const paidFixture = await checkout('paid-cancel');
    const paid = await createPayment(paidFixture, 'paid-cancel-key');
    await payments.processEvent(providerEvent(paid, 'paid-event', 'succeeded'));
    const paidStock = await stockOf(paidFixture.variant.id);
    await expect(
      orders.cancelForUser(paidFixture.user.id, paidFixture.order.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await stockOf(paidFixture.variant.id)).toBe(paidStock);

    const unpaidFixture = await checkout('unpaid-cancel');
    const unpaidAfterCheckout = await stockOf(unpaidFixture.variant.id);
    await orders.cancelForUser(unpaidFixture.user.id, unpaidFixture.order.id);
    expect(await stockOf(unpaidFixture.variant.id)).toBe(
      unpaidAfterCheckout + 2,
    );

    const raceFixture = await checkout('cancel-success-race');
    const raced = await createPayment(raceFixture, 'race-payment-key');
    await Promise.allSettled([
      orders.cancelForUser(raceFixture.user.id, raceFixture.order.id),
      payments.processEvent(providerEvent(raced, 'race-event', 'succeeded')),
    ]);
    const finalPayment = await paymentOf(raced.id);
    const finalOrder = await orderOf(raceFixture.order.id);
    expect(
      finalOrder.status === OrderStatus.CANCELLED &&
        finalPayment.status === PaymentStatus.SUCCEEDED,
    ).toBe(false);
    if (finalOrder.status === OrderStatus.CANCELLED) {
      expect(finalPayment.status).toBe(PaymentStatus.CANCELLED);
      const storedEvent = await dataSource
        .getRepository(PaymentEvent)
        .findOneByOrFail({ providerEventId: 'race-event' });
      expect(storedEvent.processingStatus).toBe(
        PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
      );
    } else {
      expect(finalOrder.status).toBe(OrderStatus.CONFIRMED);
      expect(finalPayment.status).toBe(PaymentStatus.SUCCEEDED);
    }
  });

  async function checkout(suffix: string) {
    const user = await createUser(suffix);
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
      stock: 5,
    });
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 2 }],
    });
    return { user, variant, order };
  }

  async function createUser(suffix: string) {
    return dataSource.getRepository(User).save({
      email: `${suffix}@payment.test`,
      password: 'hash',
      role: UserRole.USER,
    });
  }

  async function createPayment(
    fixture: Awaited<ReturnType<typeof checkout>>,
    key: string,
  ) {
    const view = await payments.createForOrder(
      fixture.user.id,
      fixture.order.id,
      key,
    );
    return paymentOf(view.id);
  }

  function providerEvent(
    payment: Payment,
    providerEventId: string,
    eventType: 'succeeded' | 'failed',
  ) {
    return {
      provider: payment.provider,
      providerEventId,
      providerPaymentId: payment.providerPaymentId!,
      eventType:
        eventType === 'succeeded'
          ? PaymentEventType.SUCCEEDED
          : PaymentEventType.FAILED,
    };
  }

  function paymentOf(id: number) {
    return dataSource.getRepository(Payment).findOneByOrFail({ id });
  }

  function orderOf(id: number) {
    return dataSource.getRepository(Order).findOneByOrFail({ id });
  }

  async function stockOf(id: number) {
    return (
      await dataSource.getRepository(ProductVariant).findOneByOrFail({ id })
    ).stock;
  }
});
