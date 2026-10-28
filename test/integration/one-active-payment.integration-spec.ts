import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { PaymentEventType } from '../../src/payments/entities/payment-event-type.enum';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import { FakePaymentProvider } from '../../src/payments/fake-payment.provider';
import { PaymentsService } from '../../src/payments/payments.service';
import { OrdersService } from '../../src/orders/orders.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
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

const ACTIVE_PAYMENT_MESSAGE = 'Order already has an active payment';
const ACTIVE_INDEX = 'UQ_payments_one_active_per_order';

describe('One active Payment per Order (PostgreSQL)', () => {
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
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      new PromotionsService(dataSource),
    );
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

  describe('service', () => {
    it('lets exactly one of two concurrent attempts with different keys win', async () => {
      const { user, order } = await checkout('concurrent-keys');

      const results = await Promise.allSettled([
        payments.createForOrder(user.id, order.id, 'concurrent-key-aaaa'),
        payments.createForOrder(user.id, order.id, 'concurrent-key-bbbb'),
      ]);

      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = rejected[0].reason as unknown;
      expect(reason).toBeInstanceOf(ConflictException);
      expect((reason as ConflictException).getStatus()).toBe(409);
      expect((reason as ConflictException).message).toBe(
        ACTIVE_PAYMENT_MESSAGE,
      );
      expect(await activePaymentCount(order.id)).toBe(1);
      expect(await totalPaymentCount(order.id)).toBe(1);
      expect(provider.creationCount).toBe(1);
    });

    it('returns the same Payment for the same key, sequentially and concurrently', async () => {
      const sequential = await checkout('same-key-sequential');
      const first = await payments.createForOrder(
        sequential.user.id,
        sequential.order.id,
        'same-key-seq-0001',
      );
      const again = await payments.createForOrder(
        sequential.user.id,
        sequential.order.id,
        'same-key-seq-0001',
      );
      expect(again.id).toBe(first.id);
      expect(await totalPaymentCount(sequential.order.id)).toBe(1);

      const concurrent = await checkout('same-key-concurrent');
      const both = await Promise.all([
        payments.createForOrder(
          concurrent.user.id,
          concurrent.order.id,
          'same-key-con-0001',
        ),
        payments.createForOrder(
          concurrent.user.id,
          concurrent.order.id,
          'same-key-con-0001',
        ),
      ]);
      expect(both[1].id).toBe(both[0].id);
      expect(await totalPaymentCount(concurrent.order.id)).toBe(1);
    });

    it('allows a new attempt after the previous Payment failed or was cancelled', async () => {
      const { user, order } = await checkout('retry-after-terminal');
      const first = await payments.createForOrder(
        user.id,
        order.id,
        'retry-key-0000001',
      );
      const stored = await dataSource
        .getRepository(Payment)
        .findOneByOrFail({ id: first.id });
      await payments.processEvent({
        provider: stored.provider,
        providerEventId: 'retry-failure-event',
        providerPaymentId: stored.providerPaymentId!,
        eventType: PaymentEventType.FAILED,
      });

      const second = await payments.createForOrder(
        user.id,
        order.id,
        'retry-key-0000002',
      );
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe(PaymentStatus.PROCESSING);

      await dataSource.query(
        `UPDATE "payments" SET "status" = 'cancelled' WHERE "id" = $1`,
        [second.id],
      );
      const third = await payments.createForOrder(
        user.id,
        order.id,
        'retry-key-0000003',
      );
      expect(third.status).toBe(PaymentStatus.PROCESSING);
      expect(await activePaymentCount(order.id)).toBe(1);
      expect(await totalPaymentCount(order.id)).toBe(3);
    });

    it('answers 409 from the database safety net when the application check is bypassed', async () => {
      const { user, order } = await checkout('safety-net');
      await payments.createForOrder(user.id, order.id, 'safety-key-0000001');

      // Blind both existence checks so the second attempt reaches the INSERT.
      jest.spyOn(Repository.prototype, 'existsBy').mockResolvedValue(false);
      const failure = await payments
        .createForOrder(user.id, order.id, 'safety-key-0000002')
        .catch((error: unknown) => error);
      jest.restoreAllMocks();

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).message).toBe(
        ACTIVE_PAYMENT_MESSAGE,
      );
      expect(await activePaymentCount(order.id)).toBe(1);
      expect(await totalPaymentCount(order.id)).toBe(1);
      expect(provider.creationCount).toBe(1);
    });
  });

  describe('index', () => {
    it.each(['pending', 'processing', 'succeeded'])(
      'rejects a second %s Payment for the same Order with 23505',
      async (status) => {
        const { user, order } = await checkout(`index-${status}`);
        await payments.createForOrder(user.id, order.id, 'index-key-0000001');

        await expect(
          insertRawPayment(order.id, `raw-key-${status}`, status),
        ).rejects.toMatchObject({
          driverError: { code: '23505', constraint: ACTIVE_INDEX },
        });
      },
    );

    it('does not count failed or cancelled Payments', async () => {
      const { order } = await checkout('index-terminal');

      await insertRawPayment(order.id, 'raw-key-failed-1', 'failed');
      await insertRawPayment(order.id, 'raw-key-failed-2', 'failed');
      await insertRawPayment(order.id, 'raw-key-cancelled-1', 'cancelled');
      await insertRawPayment(order.id, 'raw-key-active-1', 'pending');

      expect(await activePaymentCount(order.id)).toBe(1);
      expect(await totalPaymentCount(order.id)).toBe(4);
    });

    it('allows one active Payment per Order across different Orders', async () => {
      const first = await checkout('index-order-a');
      const second = await checkout('index-order-b');

      await insertRawPayment(first.order.id, 'raw-key-order-a', 'pending');
      await insertRawPayment(second.order.id, 'raw-key-order-b', 'pending');

      expect(await activePaymentCount(first.order.id)).toBe(1);
      expect(await activePaymentCount(second.order.id)).toBe(1);
    });
  });

  async function checkout(suffix: string) {
    const user = await dataSource.getRepository(User).save({
      email: `${suffix}@one-active.test`,
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
      stock: 5,
    });
    const order = await orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 2 }],
    });
    return { user, order };
  }

  function insertRawPayment(orderId: number, key: string, status: string) {
    return dataSource.query(
      `INSERT INTO "payments"
         ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status")
       VALUES ($1, 'fake', NULL, $2, 400000, 'VND', $3)`,
      [orderId, key, status],
    );
  }

  async function activePaymentCount(orderId: number) {
    const rows = await dataSource.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM "payments"
       WHERE "orderId" = $1 AND "status" IN ('pending', 'processing', 'succeeded')`,
      [orderId],
    );
    return rows[0].count;
  }

  function totalPaymentCount(orderId: number) {
    return dataSource.getRepository(Payment).countBy({ orderId });
  }
});
