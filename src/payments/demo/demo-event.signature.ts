import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentEventType } from '../entities/payment-event-type.enum';
import { ProviderPaymentEvent } from '../payment-event';

// The signed event of the demo store (PAYMENT_PROVIDER=demo), the counterpart of
// the MoMo IPN. A demo event is never taken on trust: it is signed with a key
// that only the API knows, and the ingress (DemoEventIngressService) checks the
// signature and the time before it hands the event to the same
// PaymentsService.processEvent a MoMo callback ends in.

// The key is derived from JWT_SECRET with this fixed label, so there is no new
// environment variable. It stays inside the API: it is never returned, logged or
// put in an error message.
export const DEMO_EVENT_KEY_LABEL = 'demo-payment-event-signing-v1';

// How far a signed event's time may be from the clock of the API, either way.
export const DEMO_EVENT_WINDOW_MS = 5 * 60_000;

export const DEMO_EVENT_SIGNING_KEY = Symbol('DEMO_EVENT_SIGNING_KEY');

export interface DemoEventEnvelope {
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  eventType: PaymentEventType;
  // A failed event that the customer cancelled.
  cancelled: boolean;
  // Empty when there is none, so the canonical string always has every field.
  failureCode: string;
  failureMessage: string;
  // Milliseconds since the epoch, when the event was signed.
  responseTime: number;
  // Hex HMAC-SHA256 of the canonical string.
  signature: string;
}

export type UnsignedDemoEvent = Omit<DemoEventEnvelope, 'signature'>;

export function deriveDemoEventKey(secret: string): Buffer {
  if (!secret) throw new Error('JWT_SECRET must be configured');
  return createHmac('sha256', secret).update(DEMO_EVENT_KEY_LABEL).digest();
}

// key=value pairs in alphabetical order joined by "&", each value URL-encoded so
// that no value can shift into the next field.
export function buildDemoEventCanonical(event: UnsignedDemoEvent): string {
  const fields: Array<[string, string]> = [
    ['cancelled', event.cancelled ? '1' : '0'],
    ['eventType', event.eventType],
    ['failureCode', event.failureCode],
    ['failureMessage', event.failureMessage],
    ['provider', event.provider],
    ['providerEventId', event.providerEventId],
    ['providerPaymentId', event.providerPaymentId],
    ['responseTime', String(event.responseTime)],
  ];
  return fields
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
}

export function signDemoEvent(event: UnsignedDemoEvent, key: Buffer): string {
  return createHmac('sha256', key)
    .update(buildDemoEventCanonical(event))
    .digest('hex');
}

// Constant-time comparison. A signature that is not 64 hex characters is simply
// wrong, never an error.
export function verifyDemoEventSignature(
  envelope: DemoEventEnvelope,
  key: Buffer,
): boolean {
  if (
    typeof envelope.signature !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(envelope.signature)
  )
    return false;
  const { signature, ...unsigned } = envelope;
  const expected = Buffer.from(signDemoEvent(unsigned, key), 'hex');
  const received = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, received);
}

export function isWithinDemoEventWindow(
  responseTime: number,
  now: Date,
): boolean {
  return (
    Number.isFinite(responseTime) &&
    Math.abs(now.getTime() - responseTime) <= DEMO_EVENT_WINDOW_MS
  );
}

export function signDemoProviderEvent(
  event: ProviderPaymentEvent,
  key: Buffer,
  now: Date = new Date(),
): DemoEventEnvelope {
  const unsigned: UnsignedDemoEvent = {
    provider: event.provider,
    providerEventId: event.providerEventId,
    providerPaymentId: event.providerPaymentId,
    eventType: event.eventType,
    cancelled: event.cancelled === true,
    failureCode: event.failureCode ?? '',
    failureMessage: event.failureMessage ?? '',
    responseTime: now.getTime(),
  };
  return { ...unsigned, signature: signDemoEvent(unsigned, key) };
}

// What the ingress passes on to PaymentsService.processEvent.
export function toProviderPaymentEvent(
  envelope: DemoEventEnvelope,
): ProviderPaymentEvent {
  return {
    provider: envelope.provider,
    providerEventId: envelope.providerEventId,
    providerPaymentId: envelope.providerPaymentId,
    eventType: envelope.eventType,
    ...(envelope.cancelled ? { cancelled: true } : {}),
    ...(envelope.failureCode ? { failureCode: envelope.failureCode } : {}),
    ...(envelope.failureMessage
      ? { failureMessage: envelope.failureMessage }
      : {}),
  };
}
