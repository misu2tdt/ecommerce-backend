import { Logger } from '@nestjs/common';
import { PaymentStatus } from '../entities/payment-status.enum';
import {
  DEMO_PAYMENT_PROVIDER,
  DEMO_PAYMENTS_WARNING,
  DemoPaymentProvider,
} from './demo-payment.provider';

describe('DemoPaymentProvider', () => {
  it('is named demo, so payments it creates are stored with provider "demo"', () => {
    expect(DEMO_PAYMENT_PROVIDER).toBe('demo');
    expect(new DemoPaymentProvider().provider).toBe('demo');
  });

  it('derives a stable, non-empty provider payment id from the payment id', () => {
    const provider = new DemoPaymentProvider();

    expect(provider.getProviderPaymentId(42)).toBe('demo_payment_42');
    expect(provider.getProviderPaymentId(42)).toBe(
      provider.getProviderPaymentId(42),
    );
    expect(provider.getProviderPaymentId(43)).not.toBe(
      provider.getProviderPaymentId(42),
    );
  });

  it('creates a processing payment without any external call or checkout link', async () => {
    const result = await new DemoPaymentProvider().createPayment({
      paymentId: 7,
      orderId: 3,
      amount: 400_000,
      currency: 'VND',
      idempotencyKey: 'demo-create-key-001',
    });

    expect(result).toEqual({
      providerPaymentId: 'demo_payment_7',
      initialStatus: PaymentStatus.PROCESSING,
    });
    expect(result).not.toHaveProperty('checkoutUrl');
  });

  it('logs one loud warning when it is switched on', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    DemoPaymentProvider.announce();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(DEMO_PAYMENTS_WARNING);
    expect(DEMO_PAYMENTS_WARNING).toBe('DEMO PAYMENTS ENABLED, no real money');
    warn.mockRestore();
  });
});
