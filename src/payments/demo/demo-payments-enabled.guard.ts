import {
  CanActivate,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PaymentProviderMode } from '../../config/environment';
import { PAYMENT_PROVIDER_MODE } from '../payments.constants';

// Runs before authentication, so when demo payments are off the endpoint looks
// like any other route that does not exist: 404 for everyone.
@Injectable()
export class DemoPaymentsEnabledGuard implements CanActivate {
  constructor(
    @Inject(PAYMENT_PROVIDER_MODE)
    private readonly mode: PaymentProviderMode,
  ) {}

  canActivate(): boolean {
    if (this.mode !== 'demo') throw new NotFoundException();
    return true;
  }
}
