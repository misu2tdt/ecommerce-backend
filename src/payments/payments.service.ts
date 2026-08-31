import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { ProviderPaymentEvent } from './payment-event';
import { PaymentProvider } from './payment-provider';
import { PaymentProviderAmbiguousError } from './provider-errors';
import { PAYMENT_CURRENCY } from './payments.constants';
import { MOMO_PROVIDER } from './momo/momo.constants';
import { VND_MIN_PAYABLE_AMOUNT } from '../money/vnd-money';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly paymentProvider: PaymentProvider,
    @Inject(PAYMENT_CURRENCY) private readonly currency: string,
  ) {}

  async createForOrder(
    userId: number,
    orderId: number,
    rawIdempotencyKey: string | undefined,
  ) {
    const idempotencyKey = this.normalizeIdempotencyKey(rawIdempotencyKey);
    let payment = await this.establishAttempt(userId, orderId, idempotencyKey);
    payment = await this.ensureProviderIdentity(payment.id);
    let continuation:
      | { checkoutUrl?: string; clientData?: Record<string, string> }
      | undefined;
    const claimed = await this.claimProviderCreation(payment.id);
    if (claimed) {
      try {
        const providerResult = await this.paymentProvider.createPayment({
          paymentId: payment.id,
          orderId: payment.orderId,
          amount: payment.amount,
          currency: payment.currency,
          idempotencyKey: payment.idempotencyKey,
        });
        await this.persistProviderCreation(
          payment.id,
          providerResult.providerPaymentId,
        );
        continuation = {
          checkoutUrl: providerResult.checkoutUrl,
          clientData: providerResult.clientData,
        };
      } catch (error) {
        if (error instanceof PaymentProviderAmbiguousError)
          await this.markProviderCreationUncertain(payment.id);
        else await this.markProviderCreationFailed(payment.id);
        throw new BadGatewayException('Payment provider creation failed');
      }
    }
    return this.toPaymentView(
      await this.dataSource.getRepository(Payment).findOneByOrFail({
        id: payment.id,
      }),
      continuation,
    );
  }

  async findForOrder(userId: number, orderId: number) {
    const owned = await this.dataSource
      .getRepository(Order)
      .existsBy({ id: orderId, userId });
    if (!owned) throw new NotFoundException('Order not found');
    const payments = await this.dataSource.getRepository(Payment).find({
      where: { orderId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return payments.map((payment) => this.toPaymentView(payment));
  }

  async findMomoReturnOrder(userId: number, providerPaymentId: string) {
    const normalized = providerPaymentId.trim();
    if (!normalized || normalized.length > 255)
      throw new BadRequestException('Invalid provider Payment identifier');
    const payment = await this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoin('payment.order', 'order')
      .where('payment.provider = :provider', {
        provider: MOMO_PROVIDER,
      })
      .andWhere('payment.providerPaymentId = :providerPaymentId', {
        providerPaymentId: normalized,
      })
      .andWhere('order.userId = :userId', { userId })
      .getOne();
    if (!payment) throw new NotFoundException('Payment return not found');
    return { orderId: payment.orderId };
  }

  processEvent(input: ProviderPaymentEvent) {
    return this.dataSource.transaction(async (manager) => {
      const paymentReference = await manager.getRepository(Payment).findOneBy({
        provider: input.provider,
        providerPaymentId: input.providerPaymentId,
      });
      if (!paymentReference) throw new NotFoundException('Payment not found');

      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(PaymentEvent)
        .values({
          paymentId: paymentReference.id,
          provider: input.provider,
          providerEventId: input.providerEventId,
          providerPaymentId: input.providerPaymentId,
          eventType: input.eventType,
          processingStatus: PaymentEventProcessingStatus.PROCESSED,
          processingMessage: null,
          processedAt: null,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      const eventId = inserted.identifiers[0]?.id as number | undefined;
      if (eventId === undefined) {
        const event = await manager
          .getRepository(PaymentEvent)
          .findOneByOrFail({
            provider: input.provider,
            providerEventId: input.providerEventId,
          });
        return { duplicate: true, event };
      }

      const payment = await manager.getRepository(Payment).findOneOrFail({
        where: { id: paymentReference.id },
        lock: { mode: 'pessimistic_write' },
      });
      const event = await manager
        .getRepository(PaymentEvent)
        .findOneByOrFail({ id: eventId });
      if (
        payment.provider !== input.provider ||
        payment.providerPaymentId !== input.providerPaymentId
      ) {
        event.processingStatus =
          PaymentEventProcessingStatus.REQUIRES_RECONCILIATION;
        event.processingMessage =
          'Provider event no longer matches the locked Payment';
        event.processedAt = new Date();
        await manager.getRepository(PaymentEvent).save(event);
        return { duplicate: false, event, payment, order: null };
      }

      const order = await manager.getRepository(Order).findOneOrFail({
        where: { id: payment.orderId },
        lock: { mode: 'pessimistic_write' },
      });

      if (input.eventType === PaymentEventType.SUCCEEDED)
        await this.processSuccess(manager, payment, order, event);
      else await this.processFailure(manager, payment, event, input);

      event.processedAt = new Date();
      await manager.getRepository(PaymentEvent).save(event);
      return { duplicate: false, event, payment, order };
    });
  }

  private async establishAttempt(
    userId: number,
    orderId: number,
    idempotencyKey: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.getRepository(Order).findOne({
        where: { id: orderId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== OrderStatus.PENDING)
        throw new ConflictException('Only a pending Order can be paid');
      if (order.totalPrice < VND_MIN_PAYABLE_AMOUNT) {
        throw new BadRequestException('Order total must be at least 1,000 VND');
      }

      const existing = await manager.getRepository(Payment).findOne({
        where: { idempotencyKey },
        relations: { order: true },
      });
      if (existing) return this.assertReusable(existing, userId, orderId);

      if (
        await manager.getRepository(Payment).existsBy({
          orderId,
          status: PaymentStatus.SUCCEEDED,
        })
      )
        throw new ConflictException('Order is already paid');

      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(Payment)
        .values({
          orderId,
          provider: this.paymentProvider.provider,
          providerPaymentId: null,
          idempotencyKey,
          amount: order.totalPrice,
          currency: this.currency,
          status: PaymentStatus.PENDING,
          failureCode: null,
          failureMessage: null,
          succeededAt: null,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      const insertedId = result.identifiers[0]?.id as number | undefined;
      if (insertedId !== undefined)
        return manager
          .getRepository(Payment)
          .findOneByOrFail({ id: insertedId });

      const raced = await manager.getRepository(Payment).findOneOrFail({
        where: { idempotencyKey },
        relations: { order: true },
      });
      return this.assertReusable(raced, userId, orderId);
    });
  }

  private async claimProviderCreation(paymentId: number) {
    return this.dataSource.transaction(async (manager) => {
      const payment = await manager.getRepository(Payment).findOneOrFail({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (payment.status !== PaymentStatus.PENDING) return false;
      const order = await manager.getRepository(Order).findOneOrFail({
        where: { id: payment.orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (order.status !== OrderStatus.PENDING) {
        payment.status = PaymentStatus.CANCELLED;
        await manager.getRepository(Payment).save(payment);
        return false;
      }
      payment.status = PaymentStatus.PROCESSING;
      await manager.getRepository(Payment).save(payment);
      return true;
    });
  }

  private async ensureProviderIdentity(paymentId: number) {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Payment);
      const payment = await repository.findOneOrFail({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      const expected = this.paymentProvider.getProviderPaymentId(payment.id);
      if (payment.providerPaymentId === null) {
        payment.providerPaymentId = expected;
        return repository.save(payment);
      }
      if (payment.providerPaymentId !== expected)
        throw new ConflictException('Payment provider identity mismatch');
      return payment;
    });
  }

  private async persistProviderCreation(
    paymentId: number,
    providerPaymentId: string,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.getRepository(Payment).findOneOrFail({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (payment.status !== PaymentStatus.PROCESSING) return;
      if (payment.providerPaymentId !== providerPaymentId)
        throw new ConflictException('Payment provider identity mismatch');
      await manager.getRepository(Payment).save(payment);
    });
  }

  private async markProviderCreationUncertain(paymentId: number) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.getRepository(Payment).findOneOrFail({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (payment.status !== PaymentStatus.PROCESSING) return;
      payment.failureCode = 'PROVIDER_OUTCOME_UNKNOWN';
      payment.failureMessage =
        'Provider payment outcome requires reconciliation';
      await manager.getRepository(Payment).save(payment);
    });
  }

  private async markProviderCreationFailed(paymentId: number) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.getRepository(Payment).findOneOrFail({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (payment.status !== PaymentStatus.PROCESSING) return;
      payment.status = PaymentStatus.FAILED;
      payment.failureCode = 'PROVIDER_CREATE_FAILED';
      payment.failureMessage = 'Provider payment creation failed';
      await manager.getRepository(Payment).save(payment);
    });
  }

  private async processSuccess(
    manager: EntityManager,
    payment: Payment,
    order: Order,
    event: PaymentEvent,
  ) {
    if (payment.status === PaymentStatus.SUCCEEDED) return;
    if (
      order.status !== OrderStatus.PENDING ||
      payment.status === PaymentStatus.CANCELLED ||
      payment.status === PaymentStatus.FAILED
    ) {
      event.processingStatus =
        PaymentEventProcessingStatus.REQUIRES_RECONCILIATION;
      event.processingMessage =
        'Provider success conflicts with terminal Payment or non-pending Order';
      return;
    }
    payment.status = PaymentStatus.SUCCEEDED;
    payment.succeededAt = new Date();
    payment.failureCode = null;
    payment.failureMessage = null;
    order.status = OrderStatus.CONFIRMED;
    await manager.getRepository(Payment).save(payment);
    await manager.getRepository(Order).save(order);
  }

  private async processFailure(
    manager: EntityManager,
    payment: Payment,
    event: PaymentEvent,
    input: ProviderPaymentEvent,
  ) {
    if (payment.status === PaymentStatus.SUCCEEDED) {
      event.processingStatus =
        PaymentEventProcessingStatus.REQUIRES_RECONCILIATION;
      event.processingMessage = 'Provider failure arrived after success';
      return;
    }
    if (payment.status === PaymentStatus.CANCELLED) return;
    payment.status = PaymentStatus.FAILED;
    payment.failureCode = this.safeProviderText(input.failureCode, 100);
    payment.failureMessage = this.safeProviderText(input.failureMessage, 500);
    await manager.getRepository(Payment).save(payment);
  }

  private assertReusable(payment: Payment, userId: number, orderId: number) {
    if (payment.orderId !== orderId || payment.order.userId !== userId)
      throw new ConflictException('Idempotency key is already in use');
    return payment;
  }

  private normalizeIdempotencyKey(value: string | undefined) {
    const normalized = value?.trim();
    if (
      !normalized ||
      normalized.length < 8 ||
      normalized.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(normalized)
    )
      throw new BadRequestException(
        'Idempotency-Key must be 8-128 safe characters',
      );
    return normalized;
  }

  private safeProviderText(value: string | undefined, maxLength: number) {
    if (!value) return null;
    return (
      value
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .slice(0, maxLength) || null
    );
  }

  private toPaymentView(
    payment: Payment,
    continuation?: {
      checkoutUrl?: string;
      clientData?: Record<string, string>;
    },
  ) {
    return {
      id: payment.id,
      provider: payment.provider,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      succeededAt: payment.succeededAt,
      ...(continuation?.checkoutUrl
        ? { checkoutUrl: continuation.checkoutUrl }
        : {}),
      ...(continuation?.clientData
        ? { clientData: continuation.clientData }
        : {}),
    };
  }
}
