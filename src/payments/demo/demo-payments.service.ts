import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PaymentProviderMode } from '../../config/environment';
import { Order } from '../../orders/entities/order.entity';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from '../entities/payment-event-type.enum';
import { Payment } from '../entities/payment.entity';
import { ProviderPaymentEvent } from '../payment-event';
import { PAYMENT_PROVIDER_MODE } from '../payments.constants';
import { PaymentsService } from '../payments.service';
import { DemoEventDeliveryService } from './demo-event-delivery.service';
import { DemoOutcome } from './dto/complete-demo-payment.dto';
import { DEMO_PAYMENT_PROVIDER } from './demo-payment.provider';

export type DemoCompletionResult =
  | 'applied'
  | 'already_applied'
  | 'recorded_for_review';

// The event id is fixed by payment and outcome, so a double click, a retry or
// a replay is the same event and only the first one is processed.
export function buildDemoProviderEvent(
  payment: { id: number; providerPaymentId: string },
  outcome: DemoOutcome,
): ProviderPaymentEvent {
  const base = {
    provider: DEMO_PAYMENT_PROVIDER,
    providerEventId: `demo:${payment.id}:${outcome}`,
    providerPaymentId: payment.providerPaymentId,
  };
  if (outcome === 'success') {
    return { ...base, eventType: PaymentEventType.SUCCEEDED };
  }
  if (outcome === 'failure') {
    return {
      ...base,
      eventType: PaymentEventType.FAILED,
      failureCode: 'DEMO_FAILURE',
      failureMessage: 'Demo payment was declined',
    };
  }
  return {
    ...base,
    eventType: PaymentEventType.FAILED,
    cancelled: true,
    failureCode: 'DEMO_CANCELLED',
    failureMessage: 'Demo payment was cancelled',
  };
}

@Injectable()
export class DemoPaymentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly paymentsService: PaymentsService,
    @Inject(PAYMENT_PROVIDER_MODE)
    private readonly mode: PaymentProviderMode,
    // Always provided by the module. Optional only so that code which builds
    // this service by hand for a check that never reaches the pipeline can
    // leave it out.
    @Optional() private readonly delivery?: DemoEventDeliveryService,
  ) {}

  async complete(userId: number, paymentId: number, outcome: DemoOutcome) {
    // The guard answers first; this keeps the service safe if it is ever
    // called from somewhere else.
    if (this.mode !== 'demo') throw new NotFoundException();

    const payment = await this.dataSource.getRepository(Payment).findOne({
      where: { id: paymentId },
      relations: { order: true },
    });
    // One answer for every reason, so ids of other customers' payments and
    // of MoMo payments cannot be told apart from ids that do not exist.
    if (
      !payment ||
      payment.order.userId !== userId ||
      payment.provider !== DEMO_PAYMENT_PROVIDER ||
      !payment.providerPaymentId
    )
      throw new NotFoundException('Payment not found');

    if (!this.delivery)
      throw new Error('Demo event delivery is not configured');
    // The event is signed and sent through the demo ingress, which verifies it
    // and then calls the same function a MoMo IPN calls
    // (PaymentsService.processEvent): event idempotency, lock order, order
    // confirmation and the late-event reconciliation all live there.
    const processed = await this.delivery.deliver(
      buildDemoProviderEvent(
        { id: payment.id, providerPaymentId: payment.providerPaymentId },
        outcome,
      ),
    );

    const stored = await this.dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: payment.id });
    const order = await this.dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: payment.orderId });
    const result: DemoCompletionResult =
      processed.event.processingStatus ===
      PaymentEventProcessingStatus.REQUIRES_RECONCILIATION
        ? 'recorded_for_review'
        : processed.duplicate
          ? 'already_applied'
          : 'applied';

    return {
      outcome,
      result,
      payment: this.paymentsService.toPaymentView(stored),
      order: { id: order.id, status: order.status },
    };
  }
}
