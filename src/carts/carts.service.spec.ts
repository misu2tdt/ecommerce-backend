import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OrdersService, PreparedCheckout } from '../orders/orders.service';
import { ProductStatus } from '../products/entities/product-status.enum';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { CartsService } from './carts.service';
import { CartItem } from './entities/cart-item.entity';
import { Cart } from './entities/cart.entity';

describe('CartsService', () => {
  const cart = {
    id: 4,
    userId: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const cartRepo = {
    findOneByOrFail: jest.fn(),
    findOneOrFail: jest.fn(),
  };
  const itemRepo = {
    find: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };
  const variantRepo = { findOne: jest.fn() };
  const manager = {
    query: jest.fn(),
    getRepository: jest.fn((entity) => {
      if (entity === Cart) return cartRepo;
      if (entity === CartItem) return itemRepo;
      if (entity === ProductVariant) return variantRepo;
    }),
  };
  const viewRepo = { findOneOrFail: jest.fn() };
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => unknown) =>
      work(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn(() => viewRepo),
  };
  const orders = { checkoutPrepared: jest.fn() };
  let service: CartsService;

  beforeEach(() => {
    jest.clearAllMocks();
    cartRepo.findOneByOrFail.mockResolvedValue(cart);
    cartRepo.findOneOrFail.mockResolvedValue(cart);
    itemRepo.find.mockResolvedValue([]);
    itemRepo.save.mockImplementation(async (value) => value);
    itemRepo.delete.mockResolvedValue({ affected: 1 });
    variantRepo.findOne.mockResolvedValue(variant());
    viewRepo.findOneOrFail.mockResolvedValue({ ...cart, items: [] });
    const promotions = {
      findAndValidate: jest.fn(),
      calculatePricing: jest.fn((subtotal: number) => ({
        subtotal,
        discount: 0,
        total: subtotal,
        appliedCoupon: null,
      })),
    };
    service = new CartsService(
      dataSource as unknown as DataSource,
      orders as unknown as OrdersService,
      promotions as unknown as any,
    );
  });

  it('lazily gets or creates one cart for the authenticated user', async () => {
    await service.getCart(7);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT ("userId") DO NOTHING'),
      [7],
    );
    expect(viewRepo.findOneOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 4, userId: 7 } }),
    );
  });

  it('uses atomic conflict increment when the same Variant is added twice', async () => {
    await service.addItem(7, { variantId: 2, quantity: 1 });
    await service.addItem(7, { variantId: 2, quantity: 3 });
    const addQueries = manager.query.mock.calls.filter(([sql]) =>
      sql.startsWith('INSERT INTO "cart_items"'),
    );
    expect(addQueries).toHaveLength(2);
    expect(addQueries[0][0]).toContain(
      '"cart_items"."quantity" + EXCLUDED."quantity"',
    );
  });

  it.each([
    ['missing Variant', null],
    ['inactive Variant', variant({ isActive: false })],
    [
      'inactive Product',
      variant({
        product: { ...variant().product, status: ProductStatus.INACTIVE },
      }),
    ],
  ])('rejects %s before adding', async (_label, selected) => {
    variantRepo.findOne.mockResolvedValue(selected);
    await expect(
      service.addItem(7, { variantId: 2, quantity: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      manager.query.mock.calls.some(([sql]) =>
        sql.startsWith('INSERT INTO "cart_items"'),
      ),
    ).toBe(false);
  });

  it('hides another user cart item as not found', async () => {
    itemRepo.findOneBy.mockResolvedValue(null);
    await expect(
      service.updateItem(7, 99, { quantity: 2 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    itemRepo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.removeItem(7, 99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates a cart item quantity', async () => {
    const item = { id: 9, cartId: 4, variantId: 2, quantity: 1 };
    itemRepo.findOneBy.mockResolvedValue(item);
    await service.updateItem(7, 9, { quantity: 5 });
    expect(itemRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 5 }),
    );
  });

  it('removes a cart item scoped to the user cart', async () => {
    await service.removeItem(7, 9);
    expect(itemRepo.delete).toHaveBeenCalledWith({ id: 9, cartId: 4 });
  });

  it('computes current line totals, cart total, availability and safe product data', async () => {
    viewRepo.findOneOrFail.mockResolvedValue({
      ...cart,
      items: [
        {
          id: 8,
          quantity: 2,
          variant: variant({ price: 125_000, stock: 1 }),
        },
      ],
    });
    const result = await service.getCart(7);
    expect(result.totalPrice).toBe(250_000);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ lineTotal: 250_000, available: false }),
    );
    expect(result.items[0].variant.product).toEqual(
      expect.objectContaining({
        primaryImage: 'https://example.test/main.jpg',
      }),
    );
    expect(result.items[0].variant.product).not.toHaveProperty('storageKey');
  });

  it('rejects checkout of an empty cart', async () => {
    orders.checkoutPrepared.mockImplementation(
      async (
        _userId,
        prepare: (manager: EntityManager) => Promise<PreparedCheckout>,
      ) => prepare(manager as unknown as EntityManager),
    );
    await expect(service.checkout(7, 12)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('delegates checkout to OrdersService and clears purchased items after success', async () => {
    itemRepo.find.mockResolvedValue([
      { id: 11, cartId: 4, variantId: 6, quantity: 2 },
    ]);
    orders.checkoutPrepared.mockImplementation(
      async (
        _userId,
        prepare: (manager: EntityManager) => Promise<PreparedCheckout>,
      ) => {
        const prepared = await prepare(manager as unknown as EntityManager);
        expect(prepared.dto).toEqual({
          addressId: 12,
          items: [{ variantId: 6, quantity: 2 }],
        });
        await prepared.afterOrderSaved?.(manager as unknown as EntityManager);
        return { id: 20 };
      },
    );
    await expect(service.checkout(7, 12)).resolves.toEqual({ id: 20 });
    expect(orders.checkoutPrepared).toHaveBeenCalledWith(
      7,
      expect.any(Function),
    );
    expect(itemRepo.delete).toHaveBeenCalledWith([11]);
  });

  it('keeps cart items when OrdersService checkout fails', async () => {
    itemRepo.find.mockResolvedValue([
      { id: 11, cartId: 4, variantId: 6, quantity: 2 },
    ]);
    orders.checkoutPrepared.mockImplementation(
      async (
        _userId,
        prepare: (manager: EntityManager) => Promise<PreparedCheckout>,
      ) => {
        await prepare(manager as unknown as EntityManager);
        throw new BadRequestException('Insufficient stock');
      },
    );
    await expect(service.checkout(7, 12)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(itemRepo.delete).not.toHaveBeenCalled();
  });
});

function variant(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    productId: 3,
    sku: 'SKU-2',
    name: 'Blue',
    price: 100_000,
    stock: 5,
    attributes: { color: 'blue' },
    isActive: true,
    position: 0,
    product: {
      id: 3,
      name: 'Product',
      slug: 'product',
      status: ProductStatus.ACTIVE,
      images: [
        {
          url: 'https://example.test/main.jpg',
          storageKey: 'must-not-leak',
          isPrimary: true,
        },
      ],
    },
    ...overrides,
  };
}
