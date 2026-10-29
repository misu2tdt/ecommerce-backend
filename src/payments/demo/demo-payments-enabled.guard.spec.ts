import { NotFoundException } from '@nestjs/common';
import { DemoPaymentsEnabledGuard } from './demo-payments-enabled.guard';

describe('DemoPaymentsEnabledGuard', () => {
  it('lets the request through when PAYMENT_PROVIDER is demo', () => {
    expect(new DemoPaymentsEnabledGuard('demo').canActivate()).toBe(true);
  });

  it('answers 404, not 401 or 403, when demo payments are off', () => {
    const guard = new DemoPaymentsEnabledGuard('momo');

    expect(() => guard.canActivate()).toThrow(NotFoundException);
    try {
      guard.canActivate();
    } catch (error) {
      // Nothing hints that a demo mode exists.
      expect((error as NotFoundException).message).toBe('Not Found');
    }
  });
});
