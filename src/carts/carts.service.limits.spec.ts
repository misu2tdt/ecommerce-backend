import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OrdersService } from '../orders/orders.service';
import { ProductStatus } from '../products/entities/product-status.enum';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { PromotionsService } from '../promotions/promotions.service';
import { MAX_LINES, MAX_QUANTITY_PER_LINE } from '../validation/limits';
import { CartsService } from './carts.service';
import { CartItem } from './entities/cart-item.entity';
import { Cart } from './entities/cart.entity';

describe('CartsService.addItem limits', () => {
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
  const itemRepo = { find: jest.fn() };
  const variantRepo = { findOne: jest.fn() };
  const manager = {
    query: jest.fn(),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Cart) return cartRepo;
      if (entity === CartItem) return itemRepo;
      if (entity === ProductVariant) return variantRepo;
    }),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: EntityManager) => unknown) =>
      work(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn(() => ({
      findOneOrFail: jest.fn().mockResolvedValue({ ...cart, items: [] }),
    })),
  };
  let service: CartsService;

  const inserted = () =>
    manager.query.mock.calls.some(([sql]: [string]) =>
      sql.startsWith('INSERT INTO "cart_items"'),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    cartRepo.findOneByOrFail.mockResolvedValue(cart);
    cartRepo.findOneOrFail.mockResolvedValue(cart);
    itemRepo.find.mockResolvedValue([]);
    variantRepo.findOne.mockResolvedValue({
      id: 2,
      isActive: true,
      product: { status: ProductStatus.ACTIVE },
    });
    service = new CartsService(
      dataSource as unknown as DataSource,
      {} as OrdersService,
      {} as PromotionsService,
    );
  });

  it('adds when the sum stays within the limit, exactly at it too', async () => {
    itemRepo.find.mockResolvedValue([
      { variantId: 2, quantity: MAX_QUANTITY_PER_LINE - 1 },
    ]);

    await service.addItem(7, { variantId: 2, quantity: 1 });

    expect(inserted()).toBe(true);
  });

  it('refuses to push a line over the limit by adding to it', async () => {
    itemRepo.find.mockResolvedValue([
      { variantId: 2, quantity: MAX_QUANTITY_PER_LINE },
    ]);

    const failure = await service
      .addItem(7, { variantId: 2, quantity: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).message).toContain(
      String(MAX_QUANTITY_PER_LINE),
    );
    expect(inserted()).toBe(false);
  });

  it('refuses a new line when the cart already has the most lines', async () => {
    itemRepo.find.mockResolvedValue(
      Array.from({ length: MAX_LINES }, (_, index) => ({
        variantId: 100 + index,
        quantity: 1,
      })),
    );

    await expect(
      service.addItem(7, { variantId: 2, quantity: 1 }),
    ).rejects.toThrow(`at most ${MAX_LINES} different products`);
    expect(inserted()).toBe(false);
  });

  it('still adds to an existing line when the cart is full of lines', async () => {
    itemRepo.find.mockResolvedValue(
      Array.from({ length: MAX_LINES }, (_, index) => ({
        variantId: index === 0 ? 2 : 100 + index,
        quantity: 1,
      })),
    );

    await service.addItem(7, { variantId: 2, quantity: 1 });

    expect(inserted()).toBe(true);
  });
});
