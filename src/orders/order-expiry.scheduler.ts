import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OrderExpiryService } from './order-expiry.service';

export const ORDER_EXPIRY_STARTUP_DELAY_MS = 30_000;
export const ORDER_EXPIRY_INTERVAL_MS = 5 * 60_000;

/**
 * Runs the order expiry sweep from inside the app, with no cron service and no
 * extra dependency: one sweep shortly after startup, then every 5 minutes.
 *
 * The startup sweep matters on Render Free: the instance sleeps when idle, so
 * its timers stop. When it wakes up, this sweep catches up on every order that
 * went overdue while it was asleep. Each instance runs its own timer; that is
 * safe because the sweep locks and re-checks every order.
 *
 * It stays off in the test environment so tests are deterministic and Jest
 * exits without open handles.
 */
@Injectable()
export class OrderExpiryScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OrderExpiryScheduler.name);
  private startTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(private readonly orderExpiry: OrderExpiryService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;

    this.startTimer = setTimeout(() => {
      void this.runSweep();
      this.intervalTimer = setInterval(
        () => void this.runSweep(),
        ORDER_EXPIRY_INTERVAL_MS,
      );
      this.intervalTimer.unref();
    }, ORDER_EXPIRY_STARTUP_DELAY_MS);
    this.startTimer.unref();
  }

  onApplicationShutdown(): void {
    clearTimeout(this.startTimer);
    clearInterval(this.intervalTimer);
    this.startTimer = undefined;
    this.intervalTimer = undefined;
  }

  private async runSweep(): Promise<void> {
    // A slow sweep must not overlap with the next tick.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const { scanned, expired, skipped, failed } =
        await this.orderExpiry.expireOverdueOrders();
      if (scanned > 0)
        this.logger.log(
          `Order expiry sweep: scanned=${scanned} expired=${expired} skipped=${skipped} failed=${failed}`,
        );
    } catch (error) {
      this.logger.error(
        `Order expiry sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.sweeping = false;
    }
  }
}
