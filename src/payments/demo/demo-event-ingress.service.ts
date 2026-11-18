import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PaymentProviderMode } from '../../config/environment';
import { Payment } from '../entities/payment.entity';
import { PAYMENT_PROVIDER_MODE } from '../payments.constants';
import { PaymentsService } from '../payments.service';
import { DEMO_PAYMENT_PROVIDER } from './demo-payment.provider';
import {
  DEMO_EVENT_SIGNING_KEY,
  DemoEventEnvelope,
  isWithinDemoEventWindow,
  toProviderPaymentEvent,
  verifyDemoEventSignature,
} from './demo-event.signature';

// The door a demo event goes through, the demo counterpart of
// MomoIpnService.process. There is no public route to it: the demo endpoints of
// the API call it in the same process.
//
// In order: demo mode, the signature, the time window, then the payment (it must
// be a demo payment and the ids must match), and only then the same
// PaymentsService.processEvent a MoMo callback ends in, so event idempotency,
// locking and the late-event reconciliation are shared, not copied.
@Injectable()
export class DemoEventIngressService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly paymentsService: PaymentsService,
    @Inject(PAYMENT_PROVIDER_MODE)
    private readonly mode: PaymentProviderMode,
    @Inject(DEMO_EVENT_SIGNING_KEY) private readonly signingKey: Buffer,
  ) {}

  async process(envelope: DemoEventEnvelope, now: Date = new Date()) {
    // One of three layers: the route guard answers first, the services check
    // again, and so does this.
    if (this.mode !== 'demo') throw new NotFoundException();

    // Nothing is read from the database before the signature is right, so a
    // forged event costs no query and leaves no trace in it.
    if (!verifyDemoEventSignature(envelope, this.signingKey))
      throw new UnauthorizedException('Invalid demo event signature');
    if (!isWithinDemoEventWindow(envelope.responseTime, now))
      throw new UnauthorizedException(
        'Demo event is outside the accepted time window',
      );

    if (envelope.provider !== DEMO_PAYMENT_PROVIDER)
      throw new NotFoundException('Payment not found');
    const payment = await this.dataSource.getRepository(Payment).findOneBy({
      provider: DEMO_PAYMENT_PROVIDER,
      providerPaymentId: envelope.providerPaymentId,
    });
    // One answer for a missing payment, a MoMo payment and ids that do not fit
    // together.
    if (
      !payment ||
      payment.provider !== DEMO_PAYMENT_PROVIDER ||
      payment.providerPaymentId !== envelope.providerPaymentId ||
      !envelope.providerEventId.startsWith(`demo:${payment.id}:`)
    )
      throw new NotFoundException('Payment not found');

    return this.paymentsService.processEvent(toProviderPaymentEvent(envelope));
  }
}
