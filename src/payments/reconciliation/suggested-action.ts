import { OrderStatus } from '../../orders/entities/order-status.enum';
import { PaymentEventType } from '../entities/payment-event-type.enum';

// A hint for the admin about what a human usually has to do. It is derived
// from the event and the order's current status and is never stored.
export function suggestReconciliationAction(
  eventType: PaymentEventType,
  orderStatus: OrderStatus,
): string {
  if (eventType === PaymentEventType.FAILED)
    return 'Review: failure arrived after success';
  if (orderStatus === OrderStatus.CANCELLED)
    return 'Refund or manually fulfil: success after the order was cancelled';
  return 'Review: success conflicted with the payment or order state; confirm the charge with the provider';
}
