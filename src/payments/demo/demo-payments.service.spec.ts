import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentEventType } from '../entities/payment-event-type.enum';
import { PaymentStatus } from '../entities/payment-status.enum';
import { PaymentsService } from '../payments.service';
import {
  buildDemoProviderEvent,
  DemoPaymentsService,
} from './demo-payments.service';

describe('buildDemoProviderEvent', () => {
  const payment = { id: 12, providerPaymentId: 'demo_payment_12' };

  it('turns success into a succeeded provider event', () => {
    expect(buildDemoProviderEvent(payment, 'success')).toEqual({
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.SUCCEEDED,
    });
  });

  it('turns failure into a failed provider event with a demo failure code', () => {
    expect(buildDemoProviderEvent(payment, 'failure')).toEqual({
      provider: 'demo',
      providerEventId: 'demo:12:failure',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.FAILED,
      failureCode: 'DEMO_FAILURE',
      failureMessage: 'Demo payment was declined',
    });
  });

  it('turns cancel into a failed event marked as cancelled', () => {
    expect(buildDemoProviderEvent(payment, 'cancel')).toEqual({
      provider: 'demo',
      providerEventId: 'demo:12:cancel',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.FAILED,
      cancelled: true,
      failureCode: 'DEMO_CANCELLED',
      failureMessage: 'Demo payment was cancelled',
    });
  });

  it('gives each payment and outcome its own deterministic event id', () => {
    const ids = [
      buildDemoProviderEvent(payment, 'success').providerEventId,
      buildDemoProviderEvent(payment, 'success').providerEventId,
      buildDemoProviderEvent(payment, 'failure').providerEventId,
      buildDemoProviderEvent({ ...payment, id: 13 }, 'success').providerEventId,
    ];

    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('DemoPaymentsService.complete', () => {
  function build(mode: 'momo' | 'demo', stored: unknown) {
    const findOne = jest.fn().mockResolvedValue(stored);
    const processEvent = jest.fn();
    const dataSource = {
      getRepository: () => ({ findOne }),
    } as unknown as DataSource;
    const payments = { processEvent } as unknown as PaymentsService;
    return {
      service: new DemoPaymentsService(dataSource, payments, mode),
      findOne,
      processEvent,
    };
  }

  it('answers 404 without touching the database when demo payments are off', async () => {
    const { service, findOne, processEvent } = build('momo', null);

    await expect(service.complete(1, 5, 'success')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findOne).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['a payment that does not exist', null],
    [
      'a payment of another customer',
      {
        id: 5,
        provider: 'demo',
        providerPaymentId: 'demo_payment_5',
        status: PaymentStatus.PROCESSING,
        order: { userId: 99 },
      },
    ],
    [
      'a MoMo payment',
      {
        id: 5,
        provider: 'momo',
        providerPaymentId: 'abc',
        status: PaymentStatus.PROCESSING,
        order: { userId: 1 },
      },
    ],
    [
      'a payment without a provider id yet',
      {
        id: 5,
        provider: 'demo',
        providerPaymentId: null,
        status: PaymentStatus.PROCESSING,
        order: { userId: 1 },
      },
    ],
  ])(
    'answers the same 404 for %s and never processes an event',
    async (_label, stored) => {
      const { service, processEvent } = build('demo', stored);

      await expect(service.complete(1, 5, 'success')).rejects.toThrow(
        new NotFoundException('Payment not found'),
      );
      expect(processEvent).not.toHaveBeenCalled();
    },
  );
});
