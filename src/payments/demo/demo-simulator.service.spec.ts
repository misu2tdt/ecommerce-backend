import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OrderStatus } from '../../orders/entities/order-status.enum';
import { Order } from '../../orders/entities/order.entity';
import { OrderExpiryService } from '../../orders/order-expiry.service';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../entities/payment-event-type.enum';
import { PaymentEvent } from '../entities/payment-event.entity';
import { PaymentStatus } from '../entities/payment-status.enum';
import { Payment } from '../entities/payment.entity';
import { PaymentsService } from '../payments.service';
import { DemoEventDeliveryService } from './demo-event-delivery.service';
import {
  DEMO_DELAYED_CALLBACK_MS,
  DEMO_RECONCILIATION_QUEUE_CAP,
  DEMO_SCENARIO_EXPLANATIONS,
  DEMO_SCENARIOS,
  DemoScenario,
} from './demo-scenarios';
import { DemoSimulatorService } from './demo-simulator.service';

type Processed = {
  duplicate: boolean;
  event: { processingStatus: PaymentEventProcessingStatus };
};

const APPLIED: Processed = {
  duplicate: false,
  event: { processingStatus: PaymentEventProcessingStatus.PROCESSED },
};
const DUPLICATE: Processed = {
  duplicate: true,
  event: { processingStatus: PaymentEventProcessingStatus.PROCESSED },
};
const REVIEW: Processed = {
  duplicate: false,
  event: {
    processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
  },
};

interface Options {
  mode?: 'momo' | 'demo';
  stored?: unknown;
  recent?: boolean;
  openEvents?: number;
  expire?: 'expired' | 'skipped';
}

function build(options: Options = {}) {
  const state = {
    payment: {
      id: 12,
      orderId: 7,
      provider: 'demo',
      providerPaymentId: 'demo_payment_12',
      status: PaymentStatus.PROCESSING,
    },
    order: { id: 7, status: OrderStatus.PENDING },
  };
  const stored =
    options.stored === undefined
      ? {
          ...state.payment,
          order: { userId: 1, status: OrderStatus.PENDING },
        }
      : options.stored;

  const paymentRepo = {
    findOne: jest.fn().mockResolvedValue(stored),
    findOneByOrFail: jest.fn().mockImplementation(() => ({ ...state.payment })),
    createQueryBuilder: jest.fn(),
  };
  const builder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(options.recent === false ? 0 : 1),
  };
  paymentRepo.createQueryBuilder.mockReturnValue(builder);
  const eventRepo = {
    countBy: jest.fn().mockResolvedValue(options.openEvents ?? 0),
  };
  const orderRepo = {
    findOneByOrFail: jest.fn().mockImplementation(() => ({ ...state.order })),
  };
  const dataSource = {
    getRepository: (entity: unknown) =>
      entity === Payment
        ? paymentRepo
        : entity === PaymentEvent
          ? eventRepo
          : entity === Order
            ? orderRepo
            : undefined,
  } as unknown as DataSource;

  const delivery = {
    sign: jest.fn((event: unknown) => ({ signed: event })),
    signTampered: jest.fn((event: unknown) => ({ tampered: event })),
    send: jest.fn(),
    deliver: jest.fn().mockResolvedValue(APPLIED),
  };
  const orderExpiry = {
    expireOrderNow: jest.fn().mockResolvedValue(options.expire ?? 'expired'),
  };
  const paymentsService = {
    toPaymentView: jest.fn((payment: { id: number; status: string }) => ({
      id: payment.id,
      status: payment.status,
    })),
  };
  const service = new DemoSimulatorService(
    dataSource,
    paymentsService as unknown as PaymentsService,
    options.mode ?? 'demo',
    delivery as unknown as DemoEventDeliveryService,
    orderExpiry as unknown as OrderExpiryService,
  );
  return {
    service,
    state,
    paymentRepo,
    eventRepo,
    delivery,
    orderExpiry,
    builder,
  };
}

const run = (
  service: DemoSimulatorService,
  scenario: DemoScenario,
  userId = 1,
  paymentId = 12,
) => service.simulate(userId, paymentId, scenario);

describe('DemoSimulatorService: guarding', () => {
  it('answers 404 without touching anything when demo payments are off', async () => {
    const { service, paymentRepo, delivery } = build({ mode: 'momo' });

    for (const scenario of DEMO_SCENARIOS) {
      await expect(run(service, scenario)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(paymentRepo.findOne).not.toHaveBeenCalled();
    expect(delivery.send).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it.each([
    ['a payment that does not exist', null],
    [
      'a payment of another customer',
      {
        id: 12,
        provider: 'demo',
        providerPaymentId: 'demo_payment_12',
        status: PaymentStatus.PROCESSING,
        order: { userId: 99 },
      },
    ],
    [
      'a MoMo payment',
      {
        id: 12,
        provider: 'momo',
        providerPaymentId: 'abc',
        status: PaymentStatus.PROCESSING,
        order: { userId: 1 },
      },
    ],
    [
      'a payment without a provider id yet',
      {
        id: 12,
        provider: 'demo',
        providerPaymentId: null,
        status: PaymentStatus.PROCESSING,
        order: { userId: 1 },
      },
    ],
  ])(
    'answers the same 404 for %s and sends nothing',
    async (_label, stored) => {
      const { service, delivery, orderExpiry } = build({ stored });

      for (const scenario of DEMO_SCENARIOS) {
        await expect(run(service, scenario)).rejects.toThrow(
          new NotFoundException('Payment not found'),
        );
      }
      expect(delivery.send).not.toHaveBeenCalled();
      expect(delivery.deliver).not.toHaveBeenCalled();
      expect(orderExpiry.expireOrderNow).not.toHaveBeenCalled();
    },
  );

  it.each([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ])('answers 409 for a payment that is already %s', async (status) => {
    const { service, delivery, orderExpiry } = build({
      stored: {
        id: 12,
        orderId: 7,
        provider: 'demo',
        providerPaymentId: 'demo_payment_12',
        status,
        order: { userId: 1, status: OrderStatus.PENDING },
      },
    });

    for (const scenario of DEMO_SCENARIOS) {
      await expect(run(service, scenario)).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
    expect(delivery.send).not.toHaveBeenCalled();
    expect(orderExpiry.expireOrderNow).not.toHaveBeenCalled();
  });
});

describe('DemoSimulatorService: success, declined and cancelled', () => {
  it('success sends one signed success event and reports applied', async () => {
    const { service, state, delivery } = build();
    delivery.send.mockImplementation(() => {
      state.payment.status = PaymentStatus.SUCCEEDED;
      state.order.status = OrderStatus.CONFIRMED;
      return Promise.resolve(APPLIED);
    });

    const result = await run(service, 'success');

    expect(delivery.sign).toHaveBeenCalledWith({
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.SUCCEEDED,
    });
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scenario: 'success',
      outcome: 'completed',
      explanation: DEMO_SCENARIO_EXPLANATIONS.success,
      payment: { id: 12, status: 'succeeded' },
      order: { id: 7, status: 'confirmed' },
    });
    expect(result.steps).toEqual([
      expect.objectContaining({
        step: 1,
        result: 'applied',
        httpStatus: 200,
      }),
    ]);
  });

  it('declined sends a failed event with the demo failure code', async () => {
    const { service, state, delivery } = build();
    delivery.send.mockImplementation(() => {
      state.payment.status = PaymentStatus.FAILED;
      return Promise.resolve(APPLIED);
    });

    const result = await run(service, 'declined');

    expect(delivery.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: 'demo:12:failure',
        eventType: PaymentEventType.FAILED,
        failureCode: 'DEMO_FAILURE',
      }),
    );
    expect(result.payment).toMatchObject({ status: 'failed' });
    expect(result.order).toEqual({ id: 7, status: 'pending' });
    expect(result.steps[0].result).toBe('applied');
  });

  it('cancelled sends a failed event marked as cancelled', async () => {
    const { service, state, delivery } = build();
    delivery.send.mockImplementation(() => {
      state.payment.status = PaymentStatus.CANCELLED;
      return Promise.resolve(APPLIED);
    });

    const result = await run(service, 'cancelled');

    expect(delivery.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: 'demo:12:cancel',
        cancelled: true,
        failureCode: 'DEMO_CANCELLED',
      }),
    );
    expect(result.payment).toMatchObject({ status: 'cancelled' });
  });

  it('reports already_applied when a new event finds the payment in that state', async () => {
    const { service, delivery } = build();
    delivery.send.mockResolvedValue(APPLIED);

    const result = await run(service, 'declined');

    expect(result.steps[0].result).toBe('already_applied');
  });

  it('reports recorded_for_review when the pipeline stores the event for an admin', async () => {
    const { service, delivery } = build();
    delivery.send.mockResolvedValue(REVIEW);

    const result = await run(service, 'success');

    expect(result.steps[0].result).toBe('recorded_for_review');
  });
});

describe('DemoSimulatorService: success_twice', () => {
  it('delivers the very same signed event twice and the second one is a duplicate', async () => {
    const { service, state, delivery } = build();
    delivery.send
      .mockImplementationOnce(() => {
        state.payment.status = PaymentStatus.SUCCEEDED;
        state.order.status = OrderStatus.CONFIRMED;
        return Promise.resolve(APPLIED);
      })
      .mockResolvedValueOnce(DUPLICATE);

    const result = await run(service, 'success_twice');

    expect(delivery.sign).toHaveBeenCalledTimes(1);
    expect(delivery.send).toHaveBeenCalledTimes(2);
    expect(delivery.send.mock.calls[0][0]).toBe(delivery.send.mock.calls[1][0]);
    expect(result.steps.map((step) => step.result)).toEqual([
      'applied',
      'duplicate',
    ]);
    expect(result.steps.map((step) => step.step)).toEqual([1, 2]);
    expect(result.payment).toMatchObject({ status: 'succeeded' });
    expect(result.order).toEqual({ id: 7, status: 'confirmed' });
  });
});

describe('DemoSimulatorService: success_after_expiry', () => {
  it('forces the expiry of this order first, then sends the signed success', async () => {
    const { service, state, delivery, orderExpiry } = build();
    orderExpiry.expireOrderNow.mockImplementation(() => {
      state.payment.status = PaymentStatus.CANCELLED;
      state.order.status = OrderStatus.CANCELLED;
      return Promise.resolve('expired');
    });
    delivery.send.mockResolvedValue(REVIEW);

    const result = await run(service, 'success_after_expiry');

    expect(orderExpiry.expireOrderNow).toHaveBeenCalledWith(7);
    expect(orderExpiry.expireOrderNow.mock.invocationCallOrder[0]).toBeLessThan(
      delivery.send.mock.invocationCallOrder[0],
    );
    expect(result.steps.map((step) => step.result)).toEqual([
      'expiry_forced',
      'recorded_for_review',
    ]);
    expect(result.steps[0].sent).toMatch(/forced, not waited for/);
    expect(result.explanation).toBe(
      DEMO_SCENARIO_EXPLANATIONS.success_after_expiry,
    );
    expect(result.explanation).toMatch(/forced, not waited for/);
    expect(result.payment).toMatchObject({ status: 'cancelled' });
    expect(result.order).toEqual({ id: 7, status: 'cancelled' });
  });

  it('is refused when the order is no longer pending', async () => {
    const { service, orderExpiry, delivery } = build({
      stored: {
        id: 12,
        orderId: 7,
        provider: 'demo',
        providerPaymentId: 'demo_payment_12',
        status: PaymentStatus.PROCESSING,
        order: { userId: 1, status: OrderStatus.CONFIRMED },
      },
    });

    await expect(run(service, 'success_after_expiry')).rejects.toThrow(
      /still waiting for payment/,
    );
    expect(orderExpiry.expireOrderNow).not.toHaveBeenCalled();
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('is refused for a payment older than 15 minutes, asking the database', async () => {
    const { service, orderExpiry, delivery, builder } = build({
      recent: false,
    });

    await expect(run(service, 'success_after_expiry')).rejects.toThrow(
      /last 15 minutes/,
    );
    expect(orderExpiry.expireOrderNow).not.toHaveBeenCalled();
    expect(delivery.send).not.toHaveBeenCalled();
    expect(builder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('now()'),
      { minutes: 15 },
    );
  });

  it('is allowed with 11 unresolved events and refused from 12', async () => {
    const allowed = build({ openEvents: DEMO_RECONCILIATION_QUEUE_CAP - 1 });
    allowed.delivery.send.mockResolvedValue(REVIEW);
    await run(allowed.service, 'success_after_expiry');
    expect(allowed.orderExpiry.expireOrderNow).toHaveBeenCalledTimes(1);

    for (const open of [12, 13, 50]) {
      const refused = build({ openEvents: open });
      await expect(
        run(refused.service, 'success_after_expiry'),
      ).rejects.toThrow(
        new ConflictException(
          `The reconciliation queue already holds ${open} unresolved events (12 or more pauses this scenario), so it is paused. Ask an admin to resolve some, or try another scenario.`,
        ),
      );
      // Refused before anything was changed.
      expect(refused.orderExpiry.expireOrderNow).not.toHaveBeenCalled();
      expect(refused.delivery.send).not.toHaveBeenCalled();
    }
  });

  it('counts only unresolved reconciliation events', async () => {
    const { service, eventRepo, delivery } = build();
    delivery.send.mockResolvedValue(REVIEW);

    await run(service, 'success_after_expiry');

    expect(eventRepo.countBy).toHaveBeenCalledWith({
      processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
      resolvedAt: expect.anything() as unknown,
    });
  });

  it('does not apply the cap to the other scenarios', async () => {
    const { service, delivery, eventRepo } = build({ openEvents: 40 });
    delivery.send.mockResolvedValue(APPLIED);

    await run(service, 'success');

    expect(eventRepo.countBy).not.toHaveBeenCalled();
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it('is refused, without sending, when the order changed before it could expire', async () => {
    const { service, delivery } = build({ expire: 'skipped' });

    await expect(run(service, 'success_after_expiry')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(delivery.send).not.toHaveBeenCalled();
  });
});

describe('DemoSimulatorService: delayed_success', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('answers at once as scheduled, and delivers the signed event after 10 seconds', async () => {
    const { service, delivery } = build();

    const result = await run(service, 'delayed_success');

    expect(DEMO_DELAYED_CALLBACK_MS).toBe(10_000);
    expect(result.outcome).toBe('scheduled');
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 1, result: 'scheduled' }),
    ]);
    // Still processing: the event has not been sent.
    expect(result.payment).toMatchObject({ status: 'processing' });
    expect(result.order).toEqual({ id: 7, status: 'pending' });
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(delivery.send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(DEMO_DELAYED_CALLBACK_MS - 1);
    expect(delivery.deliver).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith({
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.SUCCEEDED,
    });
  });

  it('drops a waiting callback when the API stops', async () => {
    const { service, delivery } = build();
    await run(service, 'delayed_success');

    service.onModuleDestroy();
    jest.advanceTimersByTime(DEMO_DELAYED_CALLBACK_MS * 2);

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('does not crash when the delayed delivery fails', async () => {
    const { service, delivery } = build();
    delivery.deliver.mockRejectedValue(new Error('database is gone'));
    await run(service, 'delayed_success');

    jest.advanceTimersByTime(DEMO_DELAYED_CALLBACK_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('DemoSimulatorService: invalid_signature', () => {
  it('sends a tampered event, reports the rejection and changes nothing', async () => {
    const { service, delivery, orderExpiry } = build();
    delivery.send.mockRejectedValue(
      new UnauthorizedException('Invalid demo event signature'),
    );

    const result = await run(service, 'invalid_signature');

    expect(delivery.signTampered).toHaveBeenCalledTimes(1);
    expect(delivery.sign).not.toHaveBeenCalled();
    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(result.steps).toEqual([
      expect.objectContaining({
        step: 1,
        result: 'rejected_invalid_signature',
        httpStatus: 401,
      }),
    ]);
    expect(result.outcome).toBe('completed');
    expect(result.payment).toMatchObject({ status: 'processing' });
    expect(result.order).toEqual({ id: 7, status: 'pending' });
    expect(orderExpiry.expireOrderNow).not.toHaveBeenCalled();
  });

  it('lets any other error through', async () => {
    const { service, delivery } = build();
    delivery.send.mockRejectedValue(new Error('database is gone'));

    await expect(run(service, 'invalid_signature')).rejects.toThrow(
      'database is gone',
    );
  });

  it('fails loudly if a forged event were ever accepted', async () => {
    const { service, delivery } = build();
    delivery.send.mockResolvedValue(APPLIED);

    await expect(run(service, 'invalid_signature')).rejects.toThrow(
      'A forged demo event was accepted',
    );
  });
});

describe('the scenario constants', () => {
  it('has an explanation for every scenario, in plain words', () => {
    for (const scenario of DEMO_SCENARIOS) {
      expect(DEMO_SCENARIO_EXPLANATIONS[scenario].length).toBeGreaterThan(40);
    }
    expect(DEMO_SCENARIOS).toEqual([
      'success',
      'declined',
      'cancelled',
      'success_twice',
      'success_after_expiry',
      'delayed_success',
      'invalid_signature',
    ]);
  });
});
