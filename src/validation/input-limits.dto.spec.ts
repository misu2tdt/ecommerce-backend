import { plainToInstance, ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from '../auth/dto/login.dto';
import { AddCartItemDto } from '../carts/dto/add-cart-item.dto';
import { CheckoutCartDto } from '../carts/dto/checkout-cart.dto';
import { UpdateCartItemDto } from '../carts/dto/update-cart-item.dto';
import { ReplaceCollectionProductsDto } from '../collections/dto/replace-collection-products.dto';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { ReconciliationQueryDto } from '../payments/reconciliation/dto/reconciliation-query.dto';
import { CreateProductImageDto } from '../products/dto/create-product-image.dto';
import { CreateProductVariantDto } from '../products/dto/create-product-variant.dto';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { ProductQueryDto } from '../products/dto/product-query.dto';
import { UpdateProductImageDto } from '../products/dto/update-product-image.dto';
import { UpdateProductVariantDto } from '../products/dto/update-product-variant.dto';
import { UpdateProductDto } from '../products/dto/update-product.dto';
import { CreateCouponDto } from '../promotions/dto/create-coupon.dto';
import { UpdateCouponDto } from '../promotions/dto/update-coupon.dto';
import { AddWishlistItemDto } from '../wishlist/dto/add-wishlist-item.dto';
import {
  INT_MAX,
  MAX_LINES,
  MAX_POSITION,
  MAX_PRICE_VND,
  MAX_QUANTITY_PER_LINE,
  MAX_STOCK,
} from './limits';

async function failedFields<T extends object>(
  type: ClassConstructor<T>,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(type, body));
  return errors.map((error) => error.property).sort();
}

const variant = { sku: 'SKU-1', name: 'Blue', price: 100_000, stock: 5 };
const coupon = { code: 'SAVE10', name: 'Save ten', type: 'FIXED', value: 5000 };

describe('limits on numbers the clients send', () => {
  describe('the bounds themselves', () => {
    it('keep an order total below the largest safe integer', () => {
      expect(MAX_PRICE_VND * MAX_QUANTITY_PER_LINE * MAX_LINES).toBeLessThan(
        Number.MAX_SAFE_INTEGER,
      );
    });
  });

  // Each row: the DTO, a valid body (which must stay valid), and a body with a
  // value over its limit (which must be refused, naming that field).
  type Row = [
    string,
    ClassConstructor<object>,
    Record<string, unknown>,
    string,
    unknown,
  ];
  const cases: Row[] = [
    [
      'cart item id',
      AddCartItemDto,
      { variantId: 1, quantity: 1 },
      'variantId',
      INT_MAX + 1,
    ],
    [
      'cart item id (huge)',
      AddCartItemDto,
      { variantId: 1, quantity: 1 },
      'variantId',
      99_999_999_999,
    ],
    [
      'cart item quantity',
      AddCartItemDto,
      { variantId: 1, quantity: 1 },
      'quantity',
      MAX_QUANTITY_PER_LINE + 1,
    ],
    [
      'cart item quantity (huge)',
      AddCartItemDto,
      { variantId: 1, quantity: 1 },
      'quantity',
      INT_MAX,
    ],
    [
      'cart item update quantity',
      UpdateCartItemDto,
      { quantity: 2 },
      'quantity',
      MAX_QUANTITY_PER_LINE + 1,
    ],
    [
      'cart checkout address',
      CheckoutCartDto,
      { addressId: 1 },
      'addressId',
      INT_MAX + 1,
    ],
    [
      'order address',
      CreateOrderDto,
      { addressId: 1, items: [{ variantId: 1, quantity: 1 }] },
      'addressId',
      INT_MAX + 1,
    ],
    [
      'wishlist product',
      AddWishlistItemDto,
      { productId: 1 },
      'productId',
      INT_MAX + 1,
    ],
    [
      'collection product ids',
      ReplaceCollectionProductsDto,
      { productIds: [1, 2] },
      'productIds',
      [1, INT_MAX + 1],
    ],
    [
      'product category',
      CreateProductDto,
      { name: 'P', categoryId: 1 },
      'categoryId',
      INT_MAX + 1,
    ],
    [
      'product brand',
      CreateProductDto,
      { name: 'P', categoryId: 1, brandId: 1 },
      'brandId',
      INT_MAX + 1,
    ],
    [
      'product update category',
      UpdateProductDto,
      { categoryId: 1 },
      'categoryId',
      INT_MAX + 1,
    ],
    [
      'product update brand',
      UpdateProductDto,
      { brandId: 1 },
      'brandId',
      INT_MAX + 1,
    ],
    [
      'image position',
      CreateProductImageDto,
      { position: 0 },
      'position',
      MAX_POSITION + 1,
    ],
    [
      'image update position',
      UpdateProductImageDto,
      { position: 0 },
      'position',
      MAX_POSITION + 1,
    ],
    [
      'variant price',
      CreateProductVariantDto,
      variant,
      'price',
      MAX_PRICE_VND + 1,
    ],
    [
      'variant price (largest safe integer)',
      CreateProductVariantDto,
      variant,
      'price',
      Number.MAX_SAFE_INTEGER,
    ],
    [
      'variant compare-at price',
      CreateProductVariantDto,
      { ...variant, compareAtPrice: 200_000 },
      'compareAtPrice',
      MAX_PRICE_VND + 1,
    ],
    ['variant stock', CreateProductVariantDto, variant, 'stock', MAX_STOCK + 1],
    [
      'variant stock (huge)',
      CreateProductVariantDto,
      variant,
      'stock',
      99_999_999_999,
    ],
    [
      'variant position',
      CreateProductVariantDto,
      { ...variant, position: 1 },
      'position',
      MAX_POSITION + 1,
    ],
    [
      'variant update price',
      UpdateProductVariantDto,
      { price: 100_000 },
      'price',
      MAX_PRICE_VND + 1,
    ],
    [
      'variant update stock',
      UpdateProductVariantDto,
      { stock: 5 },
      'stock',
      MAX_STOCK + 1,
    ],
    [
      'catalog minimum price',
      ProductQueryDto,
      { minPrice: '1000' },
      'minPrice',
      String(MAX_PRICE_VND + 1),
    ],
    [
      'catalog maximum price',
      ProductQueryDto,
      { maxPrice: '1000' },
      'maxPrice',
      String(MAX_PRICE_VND + 1),
    ],
    [
      'catalog price in exponent form',
      ProductQueryDto,
      { maxPrice: '1000' },
      'maxPrice',
      '1e30',
    ],
    ['coupon value', CreateCouponDto, coupon, 'value', MAX_PRICE_VND + 1],
    [
      'coupon minimum subtotal',
      CreateCouponDto,
      { ...coupon, minSubtotal: 1000 },
      'minSubtotal',
      MAX_PRICE_VND + 1,
    ],
    [
      'coupon maximum discount',
      CreateCouponDto,
      { ...coupon, type: 'PERCENTAGE', value: 10, maxDiscount: 1000 },
      'maxDiscount',
      MAX_PRICE_VND + 1,
    ],
    [
      'coupon update value',
      UpdateCouponDto,
      { value: 5000 },
      'value',
      MAX_PRICE_VND + 1,
    ],
    [
      'reconciliation page',
      ReconciliationQueryDto,
      { page: '1' },
      'page',
      '100001',
    ],
    [
      'reconciliation order id',
      ReconciliationQueryDto,
      { orderId: '1' },
      'orderId',
      String(INT_MAX + 1),
    ],
  ];

  it.each(cases)(
    '%s: the valid body passes, a value over the limit is refused',
    async (_label, type, valid, field, tooBig) => {
      expect(await failedFields(type, valid)).toEqual([]);
      expect(await failedFields(type, { ...valid, [field]: tooBig })).toContain(
        field,
      );
    },
  );

  it('accepts a value exactly at its limit', async () => {
    expect(
      await failedFields(AddCartItemDto, {
        variantId: INT_MAX,
        quantity: MAX_QUANTITY_PER_LINE,
      }),
    ).toEqual([]);
    expect(
      await failedFields(CreateProductVariantDto, {
        ...variant,
        price: MAX_PRICE_VND,
        stock: MAX_STOCK,
        position: MAX_POSITION,
      }),
    ).toEqual([]);
  });

  describe('an order', () => {
    const line = { variantId: 1, quantity: 1 };

    it('refuses a quantity over the limit on a line', async () => {
      const errors = await validate(
        plainToInstance(CreateOrderDto, {
          addressId: 1,
          items: [{ variantId: 1, quantity: MAX_QUANTITY_PER_LINE + 1 }],
        }),
      );
      expect(JSON.stringify(errors)).toContain('quantity');
    });

    it('refuses a variant id that does not fit an integer', async () => {
      const errors = await validate(
        plainToInstance(CreateOrderDto, {
          addressId: 1,
          items: [{ variantId: INT_MAX + 1, quantity: 1 }],
        }),
      );
      expect(JSON.stringify(errors)).toContain('variantId');
    });

    it('refuses more lines than the limit, and accepts exactly the limit', async () => {
      const lines = (count: number) =>
        Array.from({ length: count }, () => line);
      expect(
        await failedFields(CreateOrderDto, {
          addressId: 1,
          items: lines(MAX_LINES),
        }),
      ).toEqual([]);
      expect(
        await failedFields(CreateOrderDto, {
          addressId: 1,
          items: lines(MAX_LINES + 1),
        }),
      ).toContain('items');
    });
  });

  it('accepts a login email with capitals and spaces (it is normalised first)', async () => {
    // Normalisation runs before validation: spaces and capitals are fine.
    expect(
      await failedFields(LoginDto, {
        email: '  Shopper@Example.TEST ',
        password: 'x',
      }),
    ).toEqual([]);
  });
});
