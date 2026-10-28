import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatus } from './entities/order-status.enum';
import { Order } from './entities/order.entity';

/**
 * The one place that cancels an Order: used by user cancel, admin cancel and
 * order expiry.
 *
 * The caller must already be inside a transaction, hold the pessimistic locks
 * on the Order's payments (ascending id) and then on the Order, and have
 * checked that cancelling is allowed (valid transition, no succeeded payment).
 */
export async function cancelLockedOrder(
  manager: EntityManager,
  order: Order,
  payments: Payment[],
): Promise<Order> {
  const paymentRepo = manager.getRepository(Payment);
  const cancellablePayments = payments.filter((payment) =>
    [PaymentStatus.PENDING, PaymentStatus.PROCESSING].includes(payment.status),
  );
  for (const payment of cancellablePayments)
    payment.status = PaymentStatus.CANCELLED;
  if (cancellablePayments.length > 0)
    await paymentRepo.save(cancellablePayments);

  const items = await manager.getRepository(OrderItem).find({
    where: { orderId: order.id },
    order: { variantId: 'ASC', id: 'ASC' },
  });
  const quantities = new Map<number, number>();
  for (const item of items)
    quantities.set(
      item.variantId,
      (quantities.get(item.variantId) ?? 0) + item.quantity,
    );

  const variantRepo = manager.getRepository(ProductVariant);
  for (const [variantId, quantity] of [...quantities.entries()].sort(
    ([first], [second]) => first - second,
  )) {
    const variant = await variantRepo.findOne({
      where: { id: variantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!variant)
      throw new BadRequestException(`Variant ID ${variantId} does not exist`);
    variant.stock += quantity;
    await variantRepo.save(variant);
  }

  order.status = OrderStatus.CANCELLED;
  return manager.getRepository(Order).save(order);
}
