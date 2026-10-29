import { Logger } from '@nestjs/common';
import { PaymentStatus } from '../entities/payment-status.enum';
import {
  CreateProviderPaymentInput,
  CreateProviderPaymentResult,
  PaymentProvider,
} from '../payment-provider';

export const DEMO_PAYMENT_PROVIDER = 'demo';
export const DEMO_PAYMENTS_WARNING = 'DEMO PAYMENTS ENABLED, no real money';

// A stand-in provider for the public portfolio demo (PAYMENT_PROVIDER=demo).
// It makes no external call and returns no checkout link: the visitor finishes
// the payment on the store's own demo page, which sends the outcome to
// POST /payments/:id/demo/complete. That endpoint turns it into a normal
// provider event for PaymentsService.processEvent, the code path a MoMo IPN
// takes, so the business rules are the same.
export class DemoPaymentProvider extends PaymentProvider {
  readonly provider = DEMO_PAYMENT_PROVIDER;

  static announce(): void {
    new Logger('Payments').warn(DEMO_PAYMENTS_WARNING);
  }

  getProviderPaymentId(paymentId: number): string {
    return `demo_payment_${paymentId}`;
  }

  createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    return Promise.resolve({
      providerPaymentId: this.getProviderPaymentId(input.paymentId),
      initialStatus: PaymentStatus.PROCESSING,
    });
  }
}
