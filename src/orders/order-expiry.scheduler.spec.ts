import { Logger } from '@nestjs/common';
import {
  ORDER_EXPIRY_INTERVAL_MS,
  ORDER_EXPIRY_STARTUP_DELAY_MS,
  OrderExpiryScheduler,
} from './order-expiry.scheduler';
import { OrderExpiryService } from './order-expiry.service';

describe('OrderExpiryScheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const idle = { scanned: 0, expired: 0, skipped: 0, failed: 0 };
  let sweep: jest.Mock;
  let scheduler: OrderExpiryScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    sweep = jest.fn().mockResolvedValue(idle);
    scheduler = new OrderExpiryScheduler({
      expireOverdueOrders: sweep,
    } as unknown as OrderExpiryService);
  });

  afterEach(() => {
    scheduler.onApplicationShutdown();
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('does not start in the test environment', async () => {
    process.env.NODE_ENV = 'test';

    scheduler.onApplicationBootstrap();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS * 3);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('runs one sweep after the startup delay, then on every interval', async () => {
    process.env.NODE_ENV = 'development';

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_STARTUP_DELAY_MS - 1);
    expect(sweep).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('uses unref timers so it never keeps the process alive', async () => {
    process.env.NODE_ENV = 'development';

    scheduler.onApplicationBootstrap();
    const { startTimer } = scheduler as unknown as {
      startTimer: NodeJS.Timeout;
    };
    expect(startTimer.hasRef()).toBe(false);

    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_STARTUP_DELAY_MS);
    const { intervalTimer } = scheduler as unknown as {
      intervalTimer: NodeJS.Timeout;
    };
    expect(intervalTimer.hasRef()).toBe(false);
  });

  it('clears every timer on shutdown, before and after the first sweep', async () => {
    process.env.NODE_ENV = 'development';

    scheduler.onApplicationBootstrap();
    scheduler.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_STARTUP_DELAY_MS);
    expect(jest.getTimerCount()).toBe(1);
    scheduler.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
    sweep.mockClear();
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS * 2);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous sweep is still running', async () => {
    process.env.NODE_ENV = 'development';
    let finishSweep: (value: typeof idle) => void = () => undefined;
    sweep.mockImplementationOnce(
      () => new Promise<typeof idle>((resolve) => (finishSweep = resolve)),
    );

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_STARTUP_DELAY_MS);
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);

    finishSweep(idle);
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('logs a failing sweep and keeps running', async () => {
    process.env.NODE_ENV = 'development';
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    sweep.mockRejectedValueOnce(new Error('database unavailable'));

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_STARTUP_DELAY_MS);
    expect(error).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('logs one counts-only line only for sweeps that found something', async () => {
    process.env.NODE_ENV = 'development';
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    sweep
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce({ scanned: 3, expired: 2, skipped: 1, failed: 0 });

    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_STARTUP_DELAY_MS);
    expect(log).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(ORDER_EXPIRY_INTERVAL_MS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(
      'Order expiry sweep: scanned=3 expired=2 skipped=1 failed=0',
    );
  });
});
