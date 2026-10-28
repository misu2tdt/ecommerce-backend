import { OrderStatus } from '../../orders/entities/order-status.enum';
import { PaymentEventType } from '../entities/payment-event-type.enum';
import { suggestReconciliationAction } from './suggested-action';

describe('suggestReconciliationAction', () => {
  it('asks for a refund or manual fulfilment when success arrived after cancellation', () => {
    expect(
      suggestReconciliationAction(
        PaymentEventType.SUCCEEDED,
        OrderStatus.CANCELLED,
      ),
    ).toBe('Refund or manually fulfil: success after the order was cancelled');
  });

  it.each([
    OrderStatus.PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
  ])(
    'asks for a review when success conflicts with a %s Order',
    (orderStatus) => {
      expect(
        suggestReconciliationAction(PaymentEventType.SUCCEEDED, orderStatus),
      ).toBe(
        'Review: success conflicted with the payment or order state; confirm the charge with the provider',
      );
    },
  );

  it.each(Object.values(OrderStatus))(
    'asks for a review when a failure arrived after success (%s Order)',
    (orderStatus) => {
      expect(
        suggestReconciliationAction(PaymentEventType.FAILED, orderStatus),
      ).toBe('Review: failure arrived after success');
    },
  );
});
