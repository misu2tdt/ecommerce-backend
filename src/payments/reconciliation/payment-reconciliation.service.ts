import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentEventProcessingStatus } from '../entities/payment-event-type.enum';
import { PaymentEvent } from '../entities/payment-event.entity';
import {
  ReconciliationQueryDto,
  ReconciliationStatusFilter,
} from './dto/reconciliation-query.dto';
import { suggestReconciliationAction } from './suggested-action';

@Injectable()
export class PaymentReconciliationService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: ReconciliationQueryDto) {
    const { page, limit, status } = query;
    const builder = this.eventsWithContext().where(
      'event.processingStatus = :processingStatus',
      {
        processingStatus: PaymentEventProcessingStatus.REQUIRES_RECONCILIATION,
      },
    );
    if (status === ReconciliationStatusFilter.UNRESOLVED)
      builder.andWhere('event.resolvedAt IS NULL');
    if (status === ReconciliationStatusFilter.RESOLVED)
      builder.andWhere('event.resolvedAt IS NOT NULL');

    const [events, total] = await builder
      .orderBy('event.createdAt', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      items: events.map((event) => this.toItem(event)),
      page,
      limit,
      total,
    };
  }

  // Only records that a human handled the event. It deliberately changes no
  // order, payment or stock: there is no refund feature yet.
  async resolve(eventId: number, adminUserId: number, note: string) {
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(PaymentEvent);
      const event = await repository.findOne({
        where: { id: eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) throw new NotFoundException('Payment event not found');
      if (
        event.processingStatus !==
        PaymentEventProcessingStatus.REQUIRES_RECONCILIATION
      )
        throw new ConflictException(
          'Only events that require reconciliation can be resolved',
        );
      if (event.resolvedAt !== null)
        throw new ConflictException('Payment event is already resolved');

      await repository.update(
        { id: eventId },
        {
          // The database clock, like createdAt, so both share one time base.
          resolvedAt: () => 'now()',
          resolvedByUserId: adminUserId,
          resolutionNote: note,
        },
      );
    });

    const resolved = await this.eventsWithContext()
      .where('event.id = :eventId', { eventId })
      .getOneOrFail();
    return this.toItem(resolved);
  }

  private eventsWithContext() {
    return this.dataSource
      .getRepository(PaymentEvent)
      .createQueryBuilder('event')
      .innerJoinAndSelect('event.payment', 'payment')
      .innerJoinAndSelect('payment.order', 'order');
  }

  private toItem(event: PaymentEvent) {
    const { payment } = event;
    const { order } = payment;
    return {
      id: event.id,
      createdAt: event.createdAt,
      eventType: event.eventType,
      processingMessage: event.processingMessage,
      provider: event.provider,
      providerPaymentId: event.providerPaymentId,
      payment: {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
      },
      order: { id: order.id, status: order.status, userId: order.userId },
      suggestedAction: suggestReconciliationAction(
        event.eventType,
        order.status,
      ),
      resolvedAt: event.resolvedAt,
      resolvedByUserId: event.resolvedByUserId,
      resolutionNote: event.resolutionNote,
    };
  }
}
