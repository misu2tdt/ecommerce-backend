import { PaymentEventType } from './entities/payment-event-type.enum';

export interface ProviderPaymentEvent {
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  eventType: PaymentEventType;
  // A failed event that the customer cancelled: the payment ends "cancelled"
  // instead of "failed". Stored as a failed event, so no schema change.
  cancelled?: boolean;
  failureCode?: string;
  failureMessage?: string;
}
