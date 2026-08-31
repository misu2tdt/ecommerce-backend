import { BadRequestException } from '@nestjs/common';
import { VND_MAX_AMOUNT, VND_MIN_PAYABLE_AMOUNT } from '../money/vnd-money';
import { CouponType } from './entities/coupon-type.enum';
import type { Coupon } from './entities/coupon.entity';

export interface PromotionCalculationResult {
  subtotal: number;
  discount: number;
  total: number;
  appliedCoupon: {
    code: string;
    name: string;
    type: CouponType;
    value: number;
  } | null;
}

export function normalizeCouponCode(code: string | undefined | null): string {
  if (typeof code !== 'string') return '';
  return code.trim().toUpperCase();
}

export function validateCouponEligibility(
  coupon: Coupon,
  subtotal: number,
  now: Date = new Date(),
): void {
  if (!coupon.isActive) {
    throw new BadRequestException('This coupon is not active');
  }

  const nowMs = now.getTime();
  if (coupon.startsAt && nowMs < new Date(coupon.startsAt).getTime()) {
    throw new BadRequestException('This coupon has not started yet');
  }

  if (coupon.endsAt && nowMs > new Date(coupon.endsAt).getTime()) {
    throw new BadRequestException('This coupon has expired');
  }

  if (coupon.minSubtotal !== null && coupon.minSubtotal !== undefined) {
    if (subtotal < coupon.minSubtotal) {
      throw new BadRequestException(
        `This coupon requires a minimum subtotal of ${coupon.minSubtotal.toLocaleString('vi-VN')} VND`,
      );
    }
  }
}

export function calculateOrderPricing(
  subtotal: number,
  coupon?: Coupon | null,
  now: Date = new Date(),
): PromotionCalculationResult {
  if (
    !Number.isSafeInteger(subtotal) ||
    subtotal < 0 ||
    subtotal > VND_MAX_AMOUNT
  ) {
    throw new RangeError('Subtotal must be a non-negative safe integer');
  }

  if (!coupon) {
    if (subtotal < VND_MIN_PAYABLE_AMOUNT) {
      throw new BadRequestException('Order total must be at least 1,000 VND');
    }
    return {
      subtotal,
      discount: 0,
      total: subtotal,
      appliedCoupon: null,
    };
  }

  validateCouponEligibility(coupon, subtotal, now);

  let rawDiscount = 0;
  if (coupon.type === CouponType.PERCENTAGE) {
    if (
      !Number.isSafeInteger(coupon.value) ||
      coupon.value < 1 ||
      coupon.value > 100
    ) {
      throw new RangeError(
        'Percentage discount value must be an integer between 1 and 100',
      );
    }

    const rawBig = (BigInt(subtotal) * BigInt(coupon.value)) / 100n;
    if (rawBig > BigInt(VND_MAX_AMOUNT)) {
      throw new RangeError('Calculated discount exceeds safe integer range');
    }
    rawDiscount = Number(rawBig);

    if (coupon.maxDiscount !== null && coupon.maxDiscount !== undefined) {
      if (
        !Number.isSafeInteger(coupon.maxDiscount) ||
        coupon.maxDiscount <= 0
      ) {
        throw new RangeError(
          'Maximum discount must be a positive safe integer when specified',
        );
      }
      rawDiscount = Math.min(rawDiscount, coupon.maxDiscount);
    }
  } else if (coupon.type === CouponType.FIXED) {
    if (coupon.maxDiscount !== null && coupon.maxDiscount !== undefined) {
      throw new BadRequestException(
        'Fixed discount coupons cannot have a maximum discount cap',
      );
    }
    if (
      !Number.isSafeInteger(coupon.value) ||
      coupon.value <= 0 ||
      coupon.value > VND_MAX_AMOUNT
    ) {
      throw new RangeError(
        'Fixed discount value must be a positive safe integer',
      );
    }
    rawDiscount = coupon.value;
  } else {
    throw new BadRequestException('Unsupported coupon type');
  }

  const discount = Math.min(rawDiscount, subtotal);
  const total = subtotal - discount;

  if (total < VND_MIN_PAYABLE_AMOUNT) {
    throw new BadRequestException(
      'This promotion would reduce the payable total below the supported minimum.',
    );
  }

  return {
    subtotal,
    discount,
    total,
    appliedCoupon: {
      code: coupon.code,
      name: coupon.name,
      type: coupon.type,
      value: coupon.value,
    },
  };
}
