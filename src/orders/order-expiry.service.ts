import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEFAULT_ORDER_PAYMENT_WINDOW_MINUTES } from '../config/environment';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { OrderStatus } from './entities/order-status.enum';
import { Order } from './entities/order.entity';
import { cancelLockedOrder } from './order-cancellation';
import { ORDER_PAYMENT_WINDOW_MINUTES } from './orders.constants';

export interface OrderExpirySweepResult {
  scanned: number;
  expired: number;
  skipped: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 50;

// "createdAt" is a timestamp WITHOUT time zone, filled by the database clock in
// its session time zone. Convert the cutoff instant the same way, so the
// comparison never depends on the time zone of the Node.js process.
const CREATED_BEFORE_CUTOFF = `o.createdAt < (CAST(:cutoff AS timestamptz) AT TIME ZONE current_setting('TimeZone'))`;

@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject(ORDER_PAYMENT_WINDOW_MINUTES)
    private readonly paymentWindowMinutes: number = DEFAULT_ORDER_PAYMENT_WINDOW_MINUTES,
  ) {}

  /**
   * Cancels PENDING orders older than the payment window, which releases their
   * reserved stock and cancels their unfinished payments. Each order is handled
   * in its own transaction, so one failure never blocks the others. Safe to run
   * repeatedly and from several instances at once.
   */
  async expireOverdueOrders(
    now: Date = new Date(),
    batchSize: number = DEFAULT_BATCH_SIZE,
  ): Promise<OrderExpirySweepResult> {
    const cutoff = new Date(now.getTime() - this.paymentWindowMinutes * 60_000);
    const candidates = await this.dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .select('o.id')
      .where('o.status = :status', { status: OrderStatus.PENDING })
      .andWhere(CREATED_BEFORE_CUTOFF, { cutoff: cutoff.toISOString() })
      .orderBy('o.id', 'ASC')
      .limit(batchSize)
      .getMany();

    const result: OrderExpirySweepResult = {
      scanned: candidates.length,
      expired: 0,
      skipped: 0,
      failed: 0,
    };
    for (const { id } of candidates) {
      try {
        result[await this.expireOne(id, cutoff)] += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `Could not expire order ${id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return result;
  }

  /**
   * Expires ONE order now, whatever its age, through the same steps as the
   * sweep: lock its payments then the order, refuse if a payment succeeded, and
   * cancel it with cancelLockedOrder (payments cancelled, stock back on sale).
   * For the payment simulator of the demo store only: the caller has already
   * checked that this order may be expired. The sweep (expireOverdueOrders) is
   * untouched and still only looks at orders past their payment window.
   */
  expireOrderNow(orderId: number): Promise<'expired' | 'skipped'> {
    return this.dataSource.transaction(async (manager) => {
      const payments = await manager.getRepository(Payment).find({
        where: { orderId },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :orderId', { orderId })
        .andWhere('o.status = :status', { status: OrderStatus.PENDING })
        .getOne();
      if (!order) return 'skipped';
      if (payments.some(({ status }) => status === PaymentStatus.SUCCEEDED))
        return 'skipped';

      await cancelLockedOrder(manager, order, payments);
      return 'expired';
    });
  }

  private expireOne(
    orderId: number,
    cutoff: Date,
  ): Promise<'expired' | 'skipped'> {
    return this.dataSource.transaction(async (manager) => {
      // Same lock order as cancel and payment events: payments, then the Order.
      const payments = await manager.getRepository(Payment).find({
        where: { orderId },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      // Re-check under the lock: the row may have been cancelled, confirmed or
      // paid since the scan. After waiting for a lock, PostgreSQL re-evaluates
      // this WHERE clause against the latest committed row.
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :orderId', { orderId })
        .andWhere('o.status = :status', { status: OrderStatus.PENDING })
        .andWhere(CREATED_BEFORE_CUTOFF, { cutoff: cutoff.toISOString() })
        .getOne();
      if (!order) return 'skipped';
      if (payments.some(({ status }) => status === PaymentStatus.SUCCEEDED))
        return 'skipped';

      await cancelLockedOrder(manager, order, payments);
      return 'expired';
    });
  }
}
