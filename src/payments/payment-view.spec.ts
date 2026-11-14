import { PaymentStatus } from './entities/payment-status.enum';
import type { Payment } from './entities/payment.entity';
import { toPaymentView } from './payment-view';

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 42,
    orderId: 7,
    provider: 'momo',
    providerPaymentId: 'PAY42-abc123',
    idempotencyKey: 'checkout-attempt-2026-001',
    amount: 24_990_000,
    currency: 'VND',
    status: PaymentStatus.SUCCEEDED,
    failureCode: 'KEEP_OUT',
    failureMessage: 'keep out',
    createdAt: new Date('2026-10-28T09:00:00.000Z'),
    updatedAt: new Date('2026-10-28T09:20:00.000Z'),
    succeededAt: new Date('2026-10-28T09:20:00.000Z'),
    ...overrides,
  } as Payment;
}

describe('toPaymentView', () => {
  it('has exactly the safe fields', () => {
    expect(toPaymentView(payment())).toEqual({
      id: 42,
      provider: 'momo',
      amount: 24_990_000,
      currency: 'VND',
      status: 'succeeded',
      createdAt: new Date('2026-10-28T09:00:00.000Z'),
      updatedAt: new Date('2026-10-28T09:20:00.000Z'),
      succeededAt: new Date('2026-10-28T09:20:00.000Z'),
    });
  });

  it('never carries the idempotency key, the provider payment id, the order id or a failure text', () => {
    const view = toPaymentView(payment());

    for (const hidden of [
      'idempotencyKey',
      'providerPaymentId',
      'orderId',
      'failureCode',
      'failureMessage',
    ]) {
      expect(view).not.toHaveProperty(hidden);
    }
  });

  it('adds the checkout link and client data only when given', () => {
    expect(toPaymentView(payment())).not.toHaveProperty('checkoutUrl');
    expect(
      toPaymentView(payment(), {
        checkoutUrl: 'https://pay.example/checkout',
        clientData: { token: 'x' },
      }),
    ).toMatchObject({
      checkoutUrl: 'https://pay.example/checkout',
      clientData: { token: 'x' },
    });
  });

  it('keeps a missing success time as null', () => {
    expect(
      toPaymentView(
        payment({ succeededAt: null, status: PaymentStatus.PENDING }),
      ).succeededAt,
    ).toBeNull();
  });
});
