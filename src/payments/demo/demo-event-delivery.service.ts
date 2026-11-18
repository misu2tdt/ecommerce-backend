import { Inject, Injectable } from '@nestjs/common';
import { PaymentEventType } from '../entities/payment-event-type.enum';
import { ProviderPaymentEvent } from '../payment-event';
import {
  DEMO_EVENT_SIGNING_KEY,
  DemoEventEnvelope,
  signDemoProviderEvent,
} from './demo-event.signature';
import { DemoEventIngressService } from './demo-event-ingress.service';

// Signs a demo event and sends it through the ingress: "sign then ingress", the
// way a provider signs a callback and the API verifies it. Used by the demo
// complete route and by the payment simulator.
@Injectable()
export class DemoEventDeliveryService {
  constructor(
    private readonly ingress: DemoEventIngressService,
    @Inject(DEMO_EVENT_SIGNING_KEY) private readonly signingKey: Buffer,
  ) {}

  sign(event: ProviderPaymentEvent, now: Date = new Date()): DemoEventEnvelope {
    return signDemoProviderEvent(event, this.signingKey, now);
  }

  // A forged copy of a signed event: it says "succeeded" but the signature is
  // that of a failed event, so the signature does not fit what is claimed.
  signTampered(
    event: ProviderPaymentEvent,
    now: Date = new Date(),
  ): DemoEventEnvelope {
    const honest = this.sign(
      { ...event, eventType: PaymentEventType.FAILED },
      now,
    );
    return { ...honest, eventType: PaymentEventType.SUCCEEDED };
  }

  // The same signed event can be sent again (a replay): the ingress and the
  // event id decide what happens.
  send(envelope: DemoEventEnvelope, now: Date = new Date()) {
    return this.ingress.process(envelope, now);
  }

  deliver(event: ProviderPaymentEvent, now: Date = new Date()) {
    return this.send(this.sign(event, now), now);
  }
}
