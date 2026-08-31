import type { ValueTransformer } from 'typeorm';

export const VND_MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
export const VND_MIN_PAYABLE_AMOUNT = 1000;

export function parseVndAmount(value: unknown): number {
  const amount =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError('VND amount must be a non-negative safe integer');
  return amount;
}

export function multiplyVndAmount(price: number, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0)
    throw new RangeError('Quantity must be a non-negative safe integer');
  const amount = parseVndAmount(price) * quantity;
  return parseVndAmount(amount);
}

export function addVndAmounts(first: number, second: number): number {
  return parseVndAmount(parseVndAmount(first) + parseVndAmount(second));
}

export const vndMoneyTransformer: ValueTransformer = {
  to: parseVndAmount,
  from: (value: unknown) =>
    value === null || value === undefined ? value : parseVndAmount(value),
};

export const nullableVndMoneyTransformer: ValueTransformer = {
  to: (value: unknown) =>
    value === null || value === undefined ? null : parseVndAmount(value),
  from: (value: unknown) =>
    value === null || value === undefined ? null : parseVndAmount(value),
};
