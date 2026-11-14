import type { Payment } from './entities/payment.entity';

// The safe fields of a Payment, shared by the customer's payment views and the
// admin order detail. It never carries the idempotency key, the provider's
// payment id, raw provider data or any secret.
export interface PaymentContinuation {
  checkoutUrl?: string;
  clientData?: Record<string, string>;
}

export function toPaymentView(
  payment: Payment,
  continuation?: PaymentContinuation,
) {
  return {
    id: payment.id,
    provider: payment.provider,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    succeededAt: payment.succeededAt,
    ...(continuation?.checkoutUrl
      ? { checkoutUrl: continuation.checkoutUrl }
      : {}),
    ...(continuation?.clientData
      ? { clientData: continuation.clientData }
      : {}),
  };
}
