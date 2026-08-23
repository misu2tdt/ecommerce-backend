import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, QueryFailedError } from 'typeorm';
import { OrderStatus } from '../orders/entities/order-status.enum';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { CreateProductReviewDto } from './dto/create-product-review.dto';
import { ProductReview } from './entities/product-review.entity';
import { ProductReviewsService } from './product-reviews.service';

describe('ProductReviewsService', () => {
  const productRepo = { existsBy: jest.fn() };
  const eligibilityBuilder = chain({ getExists: jest.fn() });
  const itemRepo = { createQueryBuilder: jest.fn(() => eligibilityBuilder) };
  const aggregateBuilder = chain({ getRawOne: jest.fn() });
  const reviewRepo = {
    create: jest.fn<Partial<ProductReview>, [Partial<ProductReview>]>(),
    save: jest.fn<Promise<ProductReview>, [Partial<ProductReview>]>(),
    findOneBy: jest.fn<
      Promise<ProductReview | null>,
      [Partial<ProductReview>]
    >(),
    delete: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(() => aggregateBuilder),
  };
  const dataSource = {
    getRepository: jest.fn((entity) => {
      if (entity === Product) return productRepo;
      if (entity === OrderItem) return itemRepo;
      return reviewRepo;
    }),
  };
  let service: ProductReviewsService;

  beforeEach(() => {
    jest.clearAllMocks();
    productRepo.existsBy.mockResolvedValue(true);
    eligibilityBuilder.getExists.mockResolvedValue(true);
    reviewRepo.create.mockImplementation(
      (value: Partial<ProductReview>): Partial<ProductReview> => value,
    );
    reviewRepo.save.mockImplementation((value) =>
      Promise.resolve({ ...review(), ...value, id: 1 }),
    );
    reviewRepo.findOneBy.mockResolvedValue(review());
    reviewRepo.delete.mockResolvedValue({ affected: 1 });
    reviewRepo.find.mockResolvedValue([review()]);
    aggregateBuilder.getRawOne.mockResolvedValue({
      averageRating: '4.50',
      reviewCount: 2,
    });
    service = new ProductReviewsService(dataSource as unknown as DataSource);
  });

  it('allows a delivered purchaser and queries eligibility efficiently', async () => {
    await service.create(7, 3, { rating: 5, title: 'Excellent' });
    expect(eligibilityBuilder.andWhere).toHaveBeenCalledWith(
      'order.status = :status',
      { status: OrderStatus.DELIVERED },
    );
    expect(reviewRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, productId: 3, isVisible: true }),
    );
  });

  it.each(['pending', 'shipped', 'cancelled'])(
    'rejects a user without a delivered purchase (%s does not qualify)',
    async () => {
      eligibilityBuilder.getExists.mockResolvedValue(false);
      await expect(service.create(7, 3, { rating: 5 })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(reviewRepo.save).not.toHaveBeenCalled();
    },
  );

  it('maps duplicate Product review to HTTP 409', async () => {
    reviewRepo.save.mockRejectedValue(
      new QueryFailedError('INSERT', [], { code: '23505' } as never),
    );
    await expect(service.create(7, 3, { rating: 5 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('validates rating between one and five', async () => {
    const low = plainToInstance(CreateProductReviewDto, { rating: 0 });
    const high = plainToInstance(CreateProductReviewDto, { rating: 6 });
    await expect(validate(low)).resolves.not.toHaveLength(0);
    await expect(validate(high)).resolves.not.toHaveLength(0);
  });

  it('lets only the owner update/delete without rechecking purchase', async () => {
    await service.updateMine(7, 3, { rating: 4 });
    await service.removeMine(7, 3);
    expect(eligibilityBuilder.getExists).not.toHaveBeenCalled();
    reviewRepo.findOneBy.mockResolvedValue(null);
    await expect(
      service.updateMine(8, 3, { rating: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('public read filters hidden reviews and exposes no User identity', async () => {
    const result = await service.findPublic(3);
    expect(reviewRepo.find).toHaveBeenCalledWith({
      where: { productId: 3, isVisible: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    expect(result[0]).not.toHaveProperty('userId');
    expect(result[0]).not.toHaveProperty('user');
  });

  it('lists moderation fields with Product context but no User relation', async () => {
    const selected = review();
    selected.product = {
      id: 3,
      name: 'Catalog Product',
      slug: 'catalog-product',
    } as Product;
    reviewRepo.find.mockResolvedValue([selected]);

    const result = await service.findAllForAdmin();

    expect(reviewRepo.find).toHaveBeenCalledWith({
      relations: { product: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    expect(result[0]).toMatchObject({
      id: 1,
      userId: 7,
      isVisible: true,
      product: { id: 3, name: 'Catalog Product', slug: 'catalog-product' },
    });
    expect(result[0]).not.toHaveProperty('user');
  });

  it('returns only the current user review fields and 404s when absent', async () => {
    const result = await service.findMine(7, 3);
    expect(reviewRepo.findOneBy).toHaveBeenCalledWith({
      userId: 7,
      productId: 3,
    });
    expect(result).toMatchObject({
      id: 1,
      rating: 5,
      title: 'Excellent',
      body: null,
      isVisible: true,
    });
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('productId');

    reviewRepo.findOneBy.mockResolvedValue(null);
    await expect(service.findMine(7, 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('admin changes visibility without deleting and summary is visible-only', async () => {
    const hidden = await service.setVisibility(1, false);
    expect(hidden.isVisible).toBe(false);
    expect(reviewRepo.delete).not.toHaveBeenCalled();
    await expect(service.getRatingSummary(3)).resolves.toEqual({
      averageRating: 4.5,
      reviewCount: 2,
    });
    expect(aggregateBuilder.andWhere).toHaveBeenCalledWith(
      'review.isVisible = true',
    );
  });
});

function chain(extra: Record<string, jest.Mock>) {
  const builder: Record<string, jest.Mock> = { ...extra };
  for (const method of [
    'innerJoin',
    'where',
    'andWhere',
    'select',
    'addSelect',
  ])
    builder[method] = jest.fn(() => builder);
  return builder;
}

function review(): ProductReview {
  return {
    id: 1,
    userId: 7,
    user: { id: 7 } as ProductReview['user'],
    productId: 3,
    product: { id: 3 } as ProductReview['product'],
    rating: 5,
    title: 'Excellent',
    body: null,
    isVisible: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
