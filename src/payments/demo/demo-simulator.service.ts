import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import type { PaymentProviderMode } from '../../config/environment';
import { OrderStatus } from '../../orders/entities/order-status.enum';
import { Order } from '../../orders/entities/order.entity';
import { OrderExpiryService } from '../../orders/order-expiry.service';
import { PaymentEventProcessingStatus } from '../entities/payment-event-type.enum';
import { PaymentEvent } from '../entities/payment-event.entity';
import { PaymentStatus } from '../entities/payment-status.enum';
import { Payment } from '../entities/payment.entity';
import { PAYMENT_PROVIDER_MODE } from '../payments.constants';
import { PaymentsService } from '../payments.service';
import { DemoEventDeliveryService } from './demo-event-delivery.service';
import { DemoEventEnvelope } from './demo-event.signature';
import { DEMO_PAYMENT_PROVIDER } from './demo-payment.provider';
import { buildDemoProviderEvent } from './demo-payments.service';
import {
  DEMO_DELAYED_CALLBACK_MS,
  DEMO_EXPIRY_PAYMENT_MAX_AGE_MINUTES,
  DEMO_RECONCILIATION_QUEUE_CAP,
  DEMO_SCENARIO_EXPLANATIONS,
  DemoScenario,
  DemoScenarioOutcome,
  DemoScenarioStep,
  DemoStepResult,
} from './demo-scenarios';

export interface DemoSimulationResult {
  scenario: DemoScenario;
  outcome: DemoScenarioOutcome;
  explanation: string;
  steps: DemoScenarioStep[];
  // The payment and the order as they are when the answer is sent. For
  // delayed_success that is before the event arrives: still processing.
  payment: ReturnType<PaymentsService['toPaymentView']>;
  order: { id: number; status: OrderStatus };
}

type SentPayment = { id: number; providerPaymentId: string };

// The payment simulator of the demo store. Every scenario builds events the way
// the demo complete route does, signs them, and sends them through the demo
// ingress to PaymentsService.processEvent, the code a MoMo callback ends in.
// Nothing here writes a payment or an order directly, except the forced expiry,
// which uses the same cancellation as the real one.
@Injectable()
export class DemoSimulatorService implements OnModuleDestroy {
  private readonly logger = new Logger('DemoSimulator');
  // Timers of delayed callbacks that have not fired yet.
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly paymentsService: PaymentsService,
    @Inject(PAYMENT_PROVIDER_MODE)
    private readonly mode: PaymentProviderMode,
    private readonly delivery: DemoEventDeliveryService,
    private readonly orderExpiry: OrderExpiryService,
  ) {}

  // A delayed callback that is still waiting is dropped when the API stops.
  onModuleDestroy() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async simulate(
    userId: number,
    paymentId: number,
    scenario: DemoScenario,
  ): Promise<DemoSimulationResult> {
    // The guard answers first; this keeps the service safe if it is ever called
    // from somewhere else.
    if (this.mode !== 'demo') throw new NotFoundException();

    const payment = await this.loadOwnedDemoPayment(userId, paymentId);
    if (
      ![PaymentStatus.PENDING, PaymentStatus.PROCESSING].includes(
        payment.status,
      )
    )
      throw new ConflictException(
        'This payment is already finished, so a scenario cannot be run on it. Start a new payment for the order (if it is still unpaid) and try again.',
      );

    const target: SentPayment = {
      id: payment.id,
      providerPaymentId: payment.providerPaymentId as string,
    };
    const steps: DemoScenarioStep[] = [];
    let outcome: DemoScenarioOutcome = 'completed';

    switch (scenario) {
      case 'success':
        await this.sendEvent(
          steps,
          target,
          'success',
          'a signed success event',
        );
        break;
      case 'declined':
        await this.sendEvent(
          steps,
          target,
          'failure',
          'a signed "payment failed" event',
        );
        break;
      case 'cancelled':
        await this.sendEvent(
          steps,
          target,
          'cancel',
          'a signed "payment cancelled" event',
        );
        break;
      case 'success_twice': {
        // One signed message, delivered twice: the second delivery is a replay
        // of the first, inside the time window, with the same event id.
        const envelope = this.delivery.sign(
          buildDemoProviderEvent(target, 'success'),
        );
        await this.sendEnvelope(
          steps,
          target,
          envelope,
          'a signed success event',
        );
        await this.sendEnvelope(
          steps,
          target,
          envelope,
          'the same signed success event again (a retry)',
        );
        break;
      }
      case 'success_after_expiry':
        await this.successAfterExpiry(steps, payment, target);
        break;
      case 'delayed_success':
        this.scheduleSuccess(target);
        steps.push({
          step: 1,
          sent: `a signed success event, to be delivered in ${DEMO_DELAYED_CALLBACK_MS / 1000} seconds`,
          result: 'scheduled',
          httpStatus: 202,
          detail:
            'Nothing has changed yet. The payment stays processing until the event arrives.',
        });
        outcome = 'scheduled';
        break;
      case 'invalid_signature':
        await this.sendTampered(steps, target);
        break;
    }

    return this.describe(scenario, outcome, steps, payment.id);
  }

  // ---- scenarios -----------------------------------------------------------

  private async successAfterExpiry(
    steps: DemoScenarioStep[],
    payment: Payment,
    target: SentPayment,
  ) {
    // Every refusal comes before anything is changed.
    if (payment.order.status !== OrderStatus.PENDING)
      throw new ConflictException(
        'This scenario only works while the order is still waiting for payment.',
      );
    if (!(await this.isRecentPayment(payment.id)))
      throw new ConflictException(
        `This scenario only works on a payment started in the last ${DEMO_EXPIRY_PAYMENT_MAX_AGE_MINUTES} minutes. Start a new payment for the order and try again.`,
      );
    const open = await this.dataSource.getRepository(PaymentEvent).countBy({
      processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
      resolvedAt: IsNull(),
    });
    if (open >= DEMO_RECONCILIATION_QUEUE_CAP)
      throw new ConflictException(
        `The reconciliation queue already holds ${open} unresolved events (${DEMO_RECONCILIATION_QUEUE_CAP} or more pauses this scenario), so it is paused. Ask an admin to resolve some, or try another scenario.`,
      );

    const expired = await this.orderExpiry.expireOrderNow(payment.orderId);
    if (expired !== 'expired')
      throw new ConflictException(
        'The order changed while the scenario was starting, so it could not be expired. Check the order and try again.',
      );
    steps.push({
      step: steps.length + 1,
      sent: 'the order was made to expire now (forced, not waited for)',
      result: 'expiry_forced',
      httpStatus: 200,
      detail:
        'The order was cancelled by the same code as the real expiry, its payment was cancelled and its stock went back on sale.',
    });
    await this.sendEvent(
      steps,
      target,
      'success',
      'a signed success event, too late',
    );
  }

  private scheduleSuccess(target: SentPayment) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.deliverDelayed(target);
    }, DEMO_DELAYED_CALLBACK_MS);
    // A waiting callback never keeps the process alive.
    timer.unref();
    this.timers.add(timer);
  }

  private async deliverDelayed(target: SentPayment) {
    try {
      await this.delivery.deliver(buildDemoProviderEvent(target, 'success'));
    } catch (error) {
      // Never the event itself (it is signed): only what went wrong.
      this.logger.warn(
        `A delayed demo callback for payment ${target.id} could not be delivered: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  // ---- steps ---------------------------------------------------------------

  private sendEvent(
    steps: DemoScenarioStep[],
    target: SentPayment,
    outcome: 'success' | 'failure' | 'cancel',
    sent: string,
  ) {
    return this.sendEnvelope(
      steps,
      target,
      this.delivery.sign(buildDemoProviderEvent(target, outcome)),
      sent,
    );
  }

  private async sendEnvelope(
    steps: DemoScenarioStep[],
    target: SentPayment,
    envelope: DemoEventEnvelope,
    sent: string,
  ) {
    const before = await this.statusOf(target.id);
    const processed = await this.delivery.send(envelope);
    const after = await this.statusOf(target.id);
    const result: DemoStepResult =
      processed.event.processingStatus ===
      PaymentEventProcessingStatus.REQUIRES_RECONCILIATION
        ? 'recorded_for_review'
        : processed.duplicate
          ? 'duplicate'
          : before === after
            ? 'already_applied'
            : 'applied';
    steps.push({
      step: steps.length + 1,
      sent,
      result,
      httpStatus: 200,
      detail: STEP_DETAILS[result],
    });
  }

  private async sendTampered(steps: DemoScenarioStep[], target: SentPayment) {
    const forged = this.delivery.signTampered(
      buildDemoProviderEvent(target, 'success'),
    );
    try {
      await this.delivery.send(forged);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        steps.push({
          step: steps.length + 1,
          sent: 'a success event that was changed after it was signed',
          result: 'rejected_invalid_signature',
          httpStatus: 401,
          detail: STEP_DETAILS.rejected_invalid_signature,
        });
        return;
      }
      throw error;
    }
    // Reaching here would mean a forged event was accepted.
    throw new Error('A forged demo event was accepted');
  }

  // ---- reading -------------------------------------------------------------

  private async loadOwnedDemoPayment(userId: number, paymentId: number) {
    const payment = await this.dataSource.getRepository(Payment).findOne({
      where: { id: paymentId },
      relations: { order: true },
    });
    // One answer for every reason, so ids of other customers' payments and of
    // MoMo payments cannot be told apart from ids that do not exist.
    if (
      !payment ||
      payment.order.userId !== userId ||
      payment.provider !== DEMO_PAYMENT_PROVIDER ||
      !payment.providerPaymentId
    )
      throw new NotFoundException('Payment not found');
    return payment;
  }

  // The database clock decides, like every time of the payment flow.
  private async isRecentPayment(paymentId: number) {
    const count = await this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('p')
      .where('p.id = :paymentId', { paymentId })
      .andWhere(`p.createdAt > now() - (:minutes * interval '1 minute')`, {
        minutes: DEMO_EXPIRY_PAYMENT_MAX_AGE_MINUTES,
      })
      .getCount();
    return count > 0;
  }

  private async statusOf(paymentId: number) {
    return (
      await this.dataSource
        .getRepository(Payment)
        .findOneByOrFail({ id: paymentId })
    ).status;
  }

  private async describe(
    scenario: DemoScenario,
    outcome: DemoScenarioOutcome,
    steps: DemoScenarioStep[],
    paymentId: number,
  ): Promise<DemoSimulationResult> {
    const payment = await this.dataSource
      .getRepository(Payment)
      .findOneByOrFail({ id: paymentId });
    const order = await this.dataSource
      .getRepository(Order)
      .findOneByOrFail({ id: payment.orderId });
    return {
      scenario,
      outcome,
      explanation: DEMO_SCENARIO_EXPLANATIONS[scenario],
      steps,
      payment: this.paymentsService.toPaymentView(payment),
      order: { id: order.id, status: order.status },
    };
  }
}

const STEP_DETAILS: Record<
  Exclude<DemoStepResult, 'scheduled' | 'expiry_forced'>,
  string
> = {
  applied: 'The API accepted the event and the payment changed.',
  already_applied:
    'The API accepted a new event, but the payment was already in that state, so nothing changed.',
  duplicate:
    'The API had already seen this event id, so it did nothing (idempotency).',
  recorded_for_review:
    'The order could no longer take this payment, so the event was stored in the reconciliation queue for an admin.',
  rejected_invalid_signature:
    'The signature did not match the event. The API rejected it with 401 and stored nothing.',
};
