import { Injectable } from '@nestjs/common';
import { PaymentStatus } from './entities/payment-status.enum';
import {
  CreateProviderPaymentInput,
  CreateProviderPaymentResult,
  FAKE_PAYMENT_PROVIDER,
  PaymentProvider,
} from './payment-provider';

@Injectable()
export class FakePaymentProvider extends PaymentProvider {
  readonly provider = FAKE_PAYMENT_PROVIDER;
  creationCount = 0;
  lastInput: CreateProviderPaymentInput | null = null;
  private failNext = false;

  reset() {
    this.creationCount = 0;
    this.lastInput = null;
    this.failNext = false;
  }

  getProviderPaymentId(paymentId: number): string {
    return `fake_payment_${paymentId}`;
  }

  failNextCreation() {
    this.failNext = true;
  }

  createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    this.creationCount += 1;
    this.lastInput = input;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Fake provider creation failure'));
    }
    return Promise.resolve({
      providerPaymentId: this.getProviderPaymentId(input.paymentId),
      initialStatus: PaymentStatus.PROCESSING,
    });
  }
}
