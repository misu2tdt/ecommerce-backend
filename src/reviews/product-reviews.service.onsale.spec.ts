import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductStatus } from '../products/entities/product-status.enum';
import { Product } from '../products/entities/product.entity';
import { ProductReviewsService } from './product-reviews.service';

describe('reviews of a product that is not on sale', () => {
  const productRepo = { existsBy: jest.fn() };
  const reviewRepo = { find: jest.fn(), save: jest.fn(), create: jest.fn() };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) =>
      entity === Product ? productRepo : reviewRepo,
    ),
  };
  let service: ProductReviewsService;

  beforeEach(() => {
    jest.clearAllMocks();
    productRepo.existsBy.mockResolvedValue(false);
    service = new ProductReviewsService(dataSource as unknown as DataSource);
  });

  it('asks for an ACTIVE product when listing public reviews, and answers 404 otherwise', async () => {
    await expect(service.findPublic(3)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(productRepo.existsBy).toHaveBeenCalledWith({
      id: 3,
      status: ProductStatus.ACTIVE,
    });
    expect(reviewRepo.find).not.toHaveBeenCalled();
  });

  it('answers 404 and saves nothing when someone reviews it', async () => {
    await expect(service.create(7, 3, { rating: 5 })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(productRepo.existsBy).toHaveBeenCalledWith({
      id: 3,
      status: ProductStatus.ACTIVE,
    });
    expect(reviewRepo.save).not.toHaveBeenCalled();
  });
});
