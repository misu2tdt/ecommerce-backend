import { Transform } from 'class-transformer';
import { HISTORY_EMAIL_DOMAIN } from '../database/seeds/order-history/history-people';

// One account per address, whatever its case or surrounding spaces.
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// For a DTO: the email is normalised before it is validated.
export const NormalizeEmail = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );

// Domains that nobody may register an account in. The order-history seed marks
// its customers by this domain and does nothing when it finds one, so a stranger
// registering there could block the seed.
const RESERVED_EMAIL_DOMAINS: readonly string[] = [HISTORY_EMAIL_DOMAIN];

export function isReservedEmailDomain(email: string): boolean {
  const domain = normalizeEmail(email).split('@').pop() ?? '';
  return RESERVED_EMAIL_DOMAINS.includes(domain);
}
