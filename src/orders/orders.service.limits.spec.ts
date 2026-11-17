import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PromotionsService } from '../promotions/promotions.service';
import { TelegramService } from '../telegram/telegram.service';
import { MAX_LINES, MAX_QUANTITY_PER_LINE } from '../validation/limits';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

describe('OrdersService order lines', () => {
  const service = new OrdersService(
    {} as DataSource,
    {} as TelegramService,
    {} as PromotionsService,
  );
  const normalize = (items: CreateOrderDto['items']) =>
    (
      service as unknown as {
        normalizeItems(dto: CreateOrderDto): unknown;
      }
    ).normalizeItems({ addressId: 1, items });

  it('merges repeated lines of one variant and sorts by variant id', () => {
    expect(
      normalize([
        { variantId: 9, quantity: 1 },
        { variantId: 3, quantity: 2 },
        { variantId: 9, quantity: 4 },
      ]),
    ).toEqual([
      { variantId: 3, quantity: 2 },
      { variantId: 9, quantity: 5 },
    ]);
  });

  it('accepts exactly the most units of one product', () => {
    expect(() =>
      normalize([{ variantId: 1, quantity: MAX_QUANTITY_PER_LINE }]),
    ).not.toThrow();
  });

  it('refuses repeated lines that add up to more than the limit', () => {
    expect(() =>
      normalize([
        { variantId: 1, quantity: MAX_QUANTITY_PER_LINE },
        { variantId: 1, quantity: 1 },
      ]),
    ).toThrow(BadRequestException);
  });

  it('refuses more different products than the limit', () => {
    const items = Array.from({ length: MAX_LINES + 1 }, (_, index) => ({
      variantId: index + 1,
      quantity: 1,
    }));

    expect(() => normalize(items)).toThrow(
      `at most ${MAX_LINES} different products`,
    );
  });
});
