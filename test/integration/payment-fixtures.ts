import { DataSource } from 'typeorm';

// Simulates what a successful payment does: a succeeded Payment row plus a
// CONFIRMED Order. Orders are confirmed only this way, never by an admin.
export async function markOrderPaid(
  dataSource: DataSource,
  orderId: number,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO "payments"
       ("orderId", "provider", "providerPaymentId", "idempotencyKey", "amount", "currency", "status", "succeededAt")
     VALUES ($1, 'fake', NULL, $2, 400000, 'VND', 'succeeded', now())`,
    [orderId, `fixture-paid-order-${orderId}`],
  );
  await dataSource.query(
    `UPDATE "orders" SET "status" = 'confirmed' WHERE "id" = $1`,
    [orderId],
  );
}
