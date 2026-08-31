import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OrderStatus } from '../orders/entities/order-status.enum';
import { Order } from '../orders/entities/order.entity';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from './entities/payment-event-type.enum';
import { PaymentEvent } from './entities/payment-event.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { Payment } from './entities/payment.entity';
import { FakePaymentProvider } from './fake-payment.provider';
import { PaymentsService } from './payments.service';

describe('PaymentsService state rules', () => {
  const provider = new FakePaymentProvider();
  const service = new PaymentsService({} as DataSource, provider, 'VND');

  it('requires a normalized safe idempotency key before database work', () => {
    const normalize = privateMethod<(value?: string) => string>(
      service,
      'normalizeIdempotencyKey',
    );
    expect(normalize('  payment.key-001  ')).toBe('payment.key-001');
    for (const invalid of [undefined, '', 'short', 'unsafe key', '🔥🔥🔥'])
      expect(() => normalize(invalid)).toThrow(BadRequestException);
  });

  it('reuses a key only for the same logical owner and Order', () => {
    const assertReusable = privateMethod<
      (payment: Payment, userId: number, orderId: number) => Payment
    >(service, 'assertReusable');
    const payment = paymentFixture();
    expect(assertReusable(payment, 7, 3)).toBe(payment);
    expect(() => assertReusable(payment, 8, 3)).toThrow(ConflictException);
    expect(() => assertReusable(payment, 7, 4)).toThrow(ConflictException);
  });

  it('atomically succeeds Payment and confirms its pending Order', async () => {
    const paymentRepo = { save: jest.fn(async (value) => value) };
    const orderRepo = { save: jest.fn(async (value) => value) };
    const manager = managerWith(paymentRepo, orderRepo);
    const payment = paymentFixture();
    const order = orderFixture();
    const event = eventFixture();

    await privateMethod<
      (
        manager: EntityManager,
        payment: Payment,
        order: Order,
        event: PaymentEvent,
      ) => Promise<void>
    >(service, 'processSuccess')(manager, payment, order, event);

    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(payment.succeededAt).toBeInstanceOf(Date);
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(paymentRepo.save).toHaveBeenCalledWith(payment);
    expect(orderRepo.save).toHaveBeenCalledWith(order);
  });

  it('flags success after cancellation for reconciliation without invalid state', async () => {
    const paymentRepo = { save: jest.fn() };
    const orderRepo = { save: jest.fn() };
    const payment = paymentFixture({ status: PaymentStatus.CANCELLED });
    const order = orderFixture({ status: OrderStatus.CANCELLED });
    const event = eventFixture();

    await privateMethod<
      (
        manager: EntityManager,
        payment: Payment,
        order: Order,
        event: PaymentEvent,
      ) => Promise<void>
    >(service, 'processSuccess')(
      managerWith(paymentRepo, orderRepo),
      payment,
      order,
      event,
    );

    expect(payment.status).toBe(PaymentStatus.CANCELLED);
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(event.processingStatus).toBe(
      PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
    );
    expect(paymentRepo.save).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('sanitizes failure details and leaves the Order lifecycle untouched', async () => {
    const paymentRepo = { save: jest.fn(async (value) => value) };
    const payment = paymentFixture();
    const event = eventFixture({ eventType: PaymentEventType.FAILED });

    await privateMethod<
      (
        manager: EntityManager,
        payment: Payment,
        event: PaymentEvent,
        input: {
          failureCode?: string;
          failureMessage?: string;
        },
      ) => Promise<void>
    >(service, 'processFailure')(
      managerWith(paymentRepo, { save: jest.fn() }),
      payment,
      event,
      {
        failureCode: ' DECLINED\nunsafe ',
        failureMessage: ' Card\twas\ndeclined ',
      },
    );

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.failureCode).toBe('DECLINED unsafe');
    expect(payment.failureMessage).toBe('Card was declined');
  });

  it('A) rejects order with total < 1,000 VND and does not create payment attempt or call provider', async () => {
    provider.reset();
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(orderFixture({ totalPrice: 999 })),
    };
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => unknown) =>
        cb(manager),
      ),
    } as unknown as DataSource;

    const testService = new PaymentsService(dataSource, provider, 'VND');

    await expect(
      testService.createForOrder(7, 3, 'payment-key-001'),
    ).rejects.toThrow('Order total must be at least 1,000 VND');

    expect(provider.creationCount).toBe(0);
    expect(provider.lastInput).toBeNull();
  });

  it('B) rejects order with total < 1,000 VND even when an existing reusable PENDING payment exists without calling provider', async () => {
    provider.reset();
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(orderFixture({ totalPrice: 999 })),
    };
    const existingPayment = paymentFixture({
      amount: 999,
      status: PaymentStatus.PENDING,
    });
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(existingPayment),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => unknown) =>
        cb(manager),
      ),
    } as unknown as DataSource;

    const testService = new PaymentsService(dataSource, provider, 'VND');

    await expect(
      testService.createForOrder(7, 3, 'payment-key-001'),
    ).rejects.toThrow('Order total must be at least 1,000 VND');

    expect(provider.creationCount).toBe(0);
    expect(provider.lastInput).toBeNull();
  });

  it('C) allows order with total >= 1,000 VND', async () => {
    const order = orderFixture({ totalPrice: 1000 });
    const payment = paymentFixture({
      amount: 1000,
      status: PaymentStatus.PROCESSING,
    });
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      findOneOrFail: jest.fn().mockResolvedValue(order),
    };
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(payment),
      findOneOrFail: jest.fn().mockResolvedValue(payment),
      findOneByOrFail: jest.fn().mockResolvedValue(payment),
      save: jest.fn().mockResolvedValue(payment),
      existsBy: jest.fn().mockResolvedValue(false),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
      createQueryBuilder: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => unknown) =>
        cb(manager),
      ),
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
    } as unknown as DataSource;

    const testService = new PaymentsService(dataSource, provider, 'VND');
    const result = await testService.createForOrder(7, 3, 'payment-key-001');
    expect(result.amount).toBe(1000);
  });

  it('D) reuses existing idempotent payment for discounted valid order preserving exact totalPrice (718,200 VND)', async () => {
    const order = orderFixture({
      subtotalPrice: 798000,
      discountPrice: 79800,
      totalPrice: 718200,
    });
    const payment = paymentFixture({
      amount: 718200,
      status: PaymentStatus.PROCESSING,
    });
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      findOneOrFail: jest.fn().mockResolvedValue(order),
    };
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(payment),
      findOneOrFail: jest.fn().mockResolvedValue(payment),
      findOneByOrFail: jest.fn().mockResolvedValue(payment),
      save: jest.fn().mockResolvedValue(payment),
      existsBy: jest.fn().mockResolvedValue(false),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
      createQueryBuilder: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => unknown) =>
        cb(manager),
      ),
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
    } as unknown as DataSource;

    const testService = new PaymentsService(dataSource, provider, 'VND');
    const result = await testService.createForOrder(7, 3, 'payment-key-001');
    expect(result.amount).toBe(718200);
  });

  it('E) dispatches exact discounted order totalPrice (718,200 VND) to provider when creating new payment attempt', async () => {
    provider.reset();
    const order = orderFixture({
      id: 3,
      userId: 7,
      subtotalPrice: 798000,
      discountPrice: 79800,
      totalPrice: 718200,
      status: OrderStatus.PENDING,
    });

    let currentPaymentState: Payment = paymentFixture({
      id: 1,
      orderId: 3,
      idempotencyKey: 'new-discounted-idemp-key',
      amount: 718200,
      status: PaymentStatus.PENDING,
      providerPaymentId: null,
    });

    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      findOneOrFail: jest.fn().mockResolvedValue(order),
    };
    const paymentRepo = {
      findOne: jest.fn().mockResolvedValue(null), // No existing payment for idempotency key
      findOneOrFail: jest
        .fn()
        .mockImplementation(async () => currentPaymentState),
      findOneByOrFail: jest
        .fn()
        .mockImplementation(async () => currentPaymentState),
      existsBy: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockImplementation(async (entity: Payment) => {
        currentPaymentState = { ...currentPaymentState, ...entity };
        return currentPaymentState;
      }),
    };

    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
      createQueryBuilder: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      }),
    } as unknown as EntityManager;

    const dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => unknown) =>
        cb(manager),
      ),
      getRepository: jest.fn((entity) =>
        entity === Payment ? paymentRepo : orderRepo,
      ),
    } as unknown as DataSource;

    const testService = new PaymentsService(dataSource, provider, 'VND');
    const result = await testService.createForOrder(
      7,
      3,
      'new-discounted-idemp-key',
    );

    // 1. Persisted payment amount assertion
    expect(result.amount).toBe(718200);

    // 2. Provider call count assertion (exactly once)
    expect(provider.creationCount).toBe(1);

    // 3. Exact provider request payload assertion
    expect(provider.lastInput).toEqual({
      paymentId: 1,
      orderId: 3,
      amount: 718200,
      currency: 'VND',
      idempotencyKey: 'new-discounted-idemp-key',
    });
  });
});

function privateMethod<T>(target: object, name: string): T {
  const method = (target as unknown as Record<string, Function>)[name];
  return method.bind(target) as T;
}

function managerWith(paymentRepo: object, orderRepo: object): EntityManager {
  return {
    getRepository: jest.fn((entity) =>
      entity === Payment ? paymentRepo : orderRepo,
    ),
  } as unknown as EntityManager;
}

function paymentFixture(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 1,
    orderId: 3,
    order: orderFixture(),
    provider: 'fake',
    providerPaymentId: 'fake_payment_1',
    idempotencyKey: 'payment-key-001',
    amount: 400_000,
    currency: 'VND',
    status: PaymentStatus.PROCESSING,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    succeededAt: null,
    ...overrides,
  };
}

function orderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: 3,
    userId: 7,
    user: { id: 7 } as Order['user'],
    subtotalPrice: 400_000,
    discountPrice: 0,
    totalPrice: 400_000,
    couponCode: null,
    couponType: null,
    couponValue: null,
    status: OrderStatus.PENDING,
    shippingAddress: {} as Order['shippingAddress'],
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function eventFixture(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    id: 5,
    paymentId: 1,
    payment: paymentFixture(),
    provider: 'fake',
    providerEventId: 'event-1',
    providerPaymentId: 'fake_payment_1',
    eventType: PaymentEventType.SUCCEEDED,
    processingStatus: PaymentEventProcessingStatus.PROCESSED,
    processingMessage: null,
    createdAt: new Date(),
    processedAt: null,
    ...overrides,
  };
}
