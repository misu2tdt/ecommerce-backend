import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentEventType } from '../entities/payment-event-type.enum';
import { PaymentsService } from '../payments.service';
import {
  DEMO_EVENT_WINDOW_MS,
  DemoEventEnvelope,
  deriveDemoEventKey,
  signDemoProviderEvent,
} from './demo-event.signature';
import { DemoEventIngressService } from './demo-event-ingress.service';

const KEY = deriveDemoEventKey('a-test-secret-for-the-api');
const NOW = new Date('2026-11-17T10:00:00.000Z');

function envelope(
  overrides: Partial<DemoEventEnvelope> = {},
  at: Date = NOW,
): DemoEventEnvelope {
  return {
    ...signDemoProviderEvent(
      {
        provider: 'demo',
        providerEventId: 'demo:12:success',
        providerPaymentId: 'demo_payment_12',
        eventType: PaymentEventType.SUCCEEDED,
      },
      KEY,
      at,
    ),
    ...overrides,
  };
}

function build(
  mode: 'momo' | 'demo',
  stored: unknown = {
    id: 12,
    provider: 'demo',
    providerPaymentId: 'demo_payment_12',
  },
) {
  const findOneBy = jest.fn().mockResolvedValue(stored);
  const getRepository = jest.fn().mockReturnValue({ findOneBy });
  const processEvent = jest.fn().mockResolvedValue({ duplicate: false });
  const service = new DemoEventIngressService(
    { getRepository } as unknown as DataSource,
    { processEvent } as unknown as PaymentsService,
    mode,
    KEY,
  );
  return { service, getRepository, findOneBy, processEvent };
}

describe('DemoEventIngressService', () => {
  it('passes a valid event on to PaymentsService.processEvent', async () => {
    const { service, processEvent } = build('demo');

    await service.process(envelope(), NOW);

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(processEvent).toHaveBeenCalledWith({
      provider: 'demo',
      providerEventId: 'demo:12:success',
      providerPaymentId: 'demo_payment_12',
      eventType: PaymentEventType.SUCCEEDED,
    });
  });

  it('answers 404 without touching anything when demo payments are off', async () => {
    const { service, getRepository, processEvent } = build('momo');

    await expect(service.process(envelope(), NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(getRepository).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('answers 401 for a changed event, before any database read', async () => {
    const { service, getRepository, processEvent } = build('demo');

    await expect(
      service.process(envelope({ eventType: PaymentEventType.FAILED }), NOW),
    ).rejects.toThrow(
      new UnauthorizedException('Invalid demo event signature'),
    );
    expect(getRepository).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('answers 401 for an event signed with another key', async () => {
    const { service, getRepository } = build('demo');
    const forged = {
      ...envelope(),
      signature: signDemoProviderEvent(
        {
          provider: 'demo',
          providerEventId: 'demo:12:success',
          providerPaymentId: 'demo_payment_12',
          eventType: PaymentEventType.SUCCEEDED,
        },
        deriveDemoEventKey('another-secret'),
        NOW,
      ).signature,
    };

    await expect(service.process(forged, NOW)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('refuses a replay older than the window, and accepts one inside it', async () => {
    const { service, processEvent } = build('demo');
    const signedAt = envelope();

    await expect(
      service.process(
        signedAt,
        new Date(NOW.getTime() + DEMO_EVENT_WINDOW_MS + 1),
      ),
    ).rejects.toThrow(
      new UnauthorizedException(
        'Demo event is outside the accepted time window',
      ),
    );
    expect(processEvent).not.toHaveBeenCalled();

    await service.process(
      signedAt,
      new Date(NOW.getTime() + DEMO_EVENT_WINDOW_MS),
    );
    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses a future-dated event beyond the window', async () => {
    const { service } = build('demo');
    const early = envelope({}, new Date(NOW.getTime() + 10 * 60_000));

    await expect(service.process(early, NOW)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    ['a payment that does not exist', null],
    [
      'a MoMo payment with that id',
      { id: 12, provider: 'momo', providerPaymentId: 'demo_payment_12' },
    ],
    [
      'a payment with another provider id',
      { id: 12, provider: 'demo', providerPaymentId: 'demo_payment_99' },
    ],
    [
      'an event id that belongs to another payment',
      { id: 13, provider: 'demo', providerPaymentId: 'demo_payment_12' },
    ],
  ])('answers the same 404 for %s', async (_label, stored) => {
    const { service, processEvent } = build('demo', stored);

    await expect(service.process(envelope(), NOW)).rejects.toThrow(
      new NotFoundException('Payment not found'),
    );
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('refuses a signed event of another provider', async () => {
    const { service, processEvent } = build('demo');
    const momo = signDemoProviderEvent(
      {
        provider: 'momo',
        providerEventId: 'demo:12:success',
        providerPaymentId: 'demo_payment_12',
        eventType: PaymentEventType.SUCCEEDED,
      },
      KEY,
      NOW,
    );

    await expect(service.process(momo, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(processEvent).not.toHaveBeenCalled();
  });
});
