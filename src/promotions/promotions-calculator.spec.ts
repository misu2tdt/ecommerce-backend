import { BadRequestException } from '@nestjs/common';
import { VND_MAX_AMOUNT } from '../money/vnd-money';
import { CouponType } from './entities/coupon-type.enum';
import type { Coupon } from './entities/coupon.entity';
import {
  calculateOrderPricing,
  normalizeCouponCode,
  validateCouponEligibility,
} from './promotions-calculator';

function makeCoupon(overrides: Partial<Coupon>): Coupon {
  return {
    id: overrides.id ?? 1,
    code: overrides.code ?? 'TEST10',
    name: overrides.name ?? 'Test Coupon',
    type: overrides.type ?? CouponType.PERCENTAGE,
    value: overrides.value ?? 10,
    minSubtotal: overrides.minSubtotal ?? null,
    maxDiscount: overrides.maxDiscount ?? null,
    startsAt: overrides.startsAt ?? null,
    endsAt: overrides.endsAt ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Promotions Calculator', () => {
  describe('normalizeCouponCode', () => {
    it('trims and converts code to uppercase', () => {
      expect(normalizeCouponCode('  welcome10  ')).toBe('WELCOME10');
      expect(normalizeCouponCode('style-50')).toBe('STYLE-50');
      expect(normalizeCouponCode(null)).toBe('');
      expect(normalizeCouponCode(undefined)).toBe('');
    });
  });

  describe('calculateOrderPricing', () => {
    it('returns undiscounted totals when no coupon is provided', () => {
      const result = calculateOrderPricing(500000, null);
      expect(result.subtotal).toBe(500000);
      expect(result.discount).toBe(0);
      expect(result.total).toBe(500000);
      expect(result.appliedCoupon).toBeNull();
    });

    it('calculates 10% percentage discount correctly', () => {
      const coupon = makeCoupon({
        type: CouponType.PERCENTAGE,
        value: 10,
      });
      const result = calculateOrderPricing(500000, coupon);
      expect(result.subtotal).toBe(500000);
      expect(result.discount).toBe(50000);
      expect(result.total).toBe(450000);
      expect(result.appliedCoupon?.code).toBe('TEST10');
    });

    it('floors fractional percentage discounts to integer VND', () => {
      const coupon = makeCoupon({
        type: CouponType.PERCENTAGE,
        value: 15,
      });
      // 199,000 * 0.15 = 29,850
      const result = calculateOrderPricing(199000, coupon);
      expect(result.discount).toBe(29850);
      expect(result.total).toBe(169150);

      // 199,999 * 0.15 = 29999.85 -> 29999
      const result2 = calculateOrderPricing(199999, coupon);
      expect(result2.discount).toBe(29999);
      expect(result2.total).toBe(170000);
    });

    it('calculates exact 1%, 33%, and 100% percentage discounts', () => {
      const c1 = makeCoupon({ type: CouponType.PERCENTAGE, value: 1 });
      expect(calculateOrderPricing(100000, c1).discount).toBe(1000);

      const c33 = makeCoupon({ type: CouponType.PERCENTAGE, value: 33 });
      expect(calculateOrderPricing(100000, c33).discount).toBe(33000);

      const c100 = makeCoupon({ type: CouponType.PERCENTAGE, value: 100 });
      // 100% on 100,000 -> total 0 -> below minimum -> throws
      expect(() => calculateOrderPricing(100000, c100)).toThrow(
        BadRequestException,
      );
    });

    it('handles MAX_SAFE_INTEGER arithmetic exactly with BigInt', () => {
      const coupon = makeCoupon({
        type: CouponType.PERCENTAGE,
        value: 33,
      });
      const subtotal = Number.MAX_SAFE_INTEGER;
      const expectedDiscount = Number((BigInt(subtotal) * 33n) / 100n);
      const result = calculateOrderPricing(subtotal, coupon);
      expect(result.discount).toBe(expectedDiscount);
      expect(result.total).toBe(subtotal - expectedDiscount);
    });

    it('caps percentage discount at maxDiscount when configured', () => {
      const coupon = makeCoupon({
        type: CouponType.PERCENTAGE,
        value: 20,
        maxDiscount: 50000,
      });
      // 500,000 * 0.20 = 100,000 -> capped at 50,000
      const result = calculateOrderPricing(500000, coupon);
      expect(result.subtotal).toBe(500000);
      expect(result.discount).toBe(50000);
      expect(result.total).toBe(450000);
    });

    it('rejects maxDiscount <= 0', () => {
      const coupon = makeCoupon({
        type: CouponType.PERCENTAGE,
        value: 20,
        maxDiscount: 0,
      });
      expect(() => calculateOrderPricing(500000, coupon)).toThrow(RangeError);
    });

    it('rejects FIXED coupon with maxDiscount set', () => {
      const coupon = makeCoupon({
        type: CouponType.FIXED,
        value: 50000,
        maxDiscount: 100000,
      });
      expect(() => calculateOrderPricing(500000, coupon)).toThrow(
        BadRequestException,
      );
    });

    it('applies fixed VND discount correctly', () => {
      const coupon = makeCoupon({
        type: CouponType.FIXED,
        value: 50000,
      });
      const result = calculateOrderPricing(500000, coupon);
      expect(result.subtotal).toBe(500000);
      expect(result.discount).toBe(50000);
      expect(result.total).toBe(450000);
    });

    it('enforces minimum payable amount rule (>= 1,000 VND)', () => {
      // 1. subtotal = 0, discount = 0, total = 0 => REJECT
      expect(() => calculateOrderPricing(0, null)).toThrow(
        'Order total must be at least 1,000 VND',
      );

      // 2. subtotal = 999, discount = 0, total = 999 => REJECT
      expect(() => calculateOrderPricing(999, null)).toThrow(
        'Order total must be at least 1,000 VND',
      );

      // 3. subtotal = 1000, discount = 0, total = 1000 => ALLOW
      const r1 = calculateOrderPricing(1000, null);
      expect(r1.total).toBe(1000);

      // 4. subtotal = 1000, fixed discount = 1 => total = 999 => REJECT
      const coupon1 = makeCoupon({ type: CouponType.FIXED, value: 1 });
      expect(() => calculateOrderPricing(1000, coupon1)).toThrow(
        'This promotion would reduce the payable total below the supported minimum.',
      );

      // 5. subtotal = 500000, discount = 500000, total = 0 => REJECT
      const couponFull = makeCoupon({ type: CouponType.FIXED, value: 500000 });
      expect(() => calculateOrderPricing(500000, couponFull)).toThrow(
        'This promotion would reduce the payable total below the supported minimum.',
      );
    });

    it('throws on negative or unsafe subtotal numbers', () => {
      expect(() => calculateOrderPricing(-100, null)).toThrow(RangeError);
      expect(() => calculateOrderPricing(1.5, null)).toThrow(RangeError);
      expect(() => calculateOrderPricing(VND_MAX_AMOUNT + 1, null)).toThrow(
        RangeError,
      );
    });
  });

  describe('validateCouponEligibility', () => {
    it('passes when coupon is active and subtotal meets minimum', () => {
      const coupon = makeCoupon({
        isActive: true,
        minSubtotal: 300000,
      });
      expect(() =>
        validateCouponEligibility(coupon, 300000, new Date()),
      ).not.toThrow();
    });

    it('throws BadRequestException when coupon is inactive', () => {
      const coupon = makeCoupon({ isActive: false });
      expect(() =>
        validateCouponEligibility(coupon, 500000, new Date()),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when subtotal is below minSubtotal', () => {
      const coupon = makeCoupon({ minSubtotal: 300000 });
      expect(() =>
        validateCouponEligibility(coupon, 299000, new Date()),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when now is before startsAt', () => {
      const coupon = makeCoupon({
        startsAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(() =>
        validateCouponEligibility(
          coupon,
          500000,
          new Date('2026-05-01T00:00:00Z'),
        ),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when now is after endsAt', () => {
      const coupon = makeCoupon({
        endsAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(() =>
        validateCouponEligibility(
          coupon,
          500000,
          new Date('2026-02-01T00:00:00Z'),
        ),
      ).toThrow(BadRequestException);
    });
  });
});
