import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Paging } from '../pagination/pagination';
import { isUniqueViolation } from '../catalog/database-errors';
import { OrderStatus } from '../orders/entities/order-status.enum';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { CreateProductReviewDto } from './dto/create-product-review.dto';
import { UpdateProductReviewDto } from './dto/update-product-review.dto';
import { ProductReview } from './entities/product-review.entity';

@Injectable()
export class ProductReviewsService {
  constructor(private readonly dataSource: DataSource) {}

  async create(userId: number, productId: number, dto: CreateProductReviewDto) {
    if (
      !(await this.dataSource
        .getRepository(Product)
        .existsBy({ id: productId }))
    )
      throw new NotFoundException('Product not found');
    if (!(await this.hasDeliveredPurchase(userId, productId)))
      throw new ForbiddenException(
        'A delivered purchase is required to review this Product',
      );

    const repository = this.dataSource.getRepository(ProductReview);
    try {
      return await repository.save(
        repository.create({
          userId,
          productId,
          rating: dto.rating,
          title: dto.title ?? null,
          body: dto.body ?? null,
          isVisible: true,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('Product review already exists');
      throw error;
    }
  }

  async updateMine(
    userId: number,
    productId: number,
    dto: UpdateProductReviewDto,
  ) {
    const repository = this.dataSource.getRepository(ProductReview);
    const review = await repository.findOneBy({ userId, productId });
    if (!review) throw new NotFoundException('Product review not found');
    Object.assign(review, dto);
    return repository.save(review);
  }

  async findMine(userId: number, productId: number) {
    const review = await this.dataSource
      .getRepository(ProductReview)
      .findOneBy({ userId, productId });
    if (!review) throw new NotFoundException('Product review not found');
    return this.toReviewResponse(review, true);
  }

  async removeMine(userId: number, productId: number) {
    const result = await this.dataSource
      .getRepository(ProductReview)
      .delete({ userId, productId });
    if (!result.affected)
      throw new NotFoundException('Product review not found');
  }

  async findPublic(productId: number) {
    if (
      !(await this.dataSource
        .getRepository(Product)
        .existsBy({ id: productId }))
    )
      throw new NotFoundException('Product not found');
    const reviews = await this.dataSource.getRepository(ProductReview).find({
      where: { productId, isVisible: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return reviews.map((review) => this.toReviewResponse(review));
  }

  async findAllForAdmin() {
    const reviews = await this.dataSource.getRepository(ProductReview).find({
      relations: { product: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return reviews.map((review) => this.toAdminReview(review));
  }

  async findPageForAdmin(paging: Paging) {
    const [reviews, total] = await this.dataSource
      .getRepository(ProductReview)
      .findAndCount({
        relations: { product: true },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: paging.offset,
        take: paging.limit,
      });
    return {
      items: reviews.map((review) => this.toAdminReview(review)),
      total,
    };
  }

  private toAdminReview(review: ProductReview) {
    return {
      id: review.id,
      userId: review.userId,
      rating: review.rating,
      title: review.title,
      body: review.body,
      isVisible: review.isVisible,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      product: {
        id: review.product.id,
        name: review.product.name,
        slug: review.product.slug,
      },
    };
  }

  async setVisibility(reviewId: number, isVisible: boolean) {
    const repository = this.dataSource.getRepository(ProductReview);
    const review = await repository.findOneBy({ id: reviewId });
    if (!review) throw new NotFoundException('Product review not found');
    review.isVisible = isVisible;
    return repository.save(review);
  }

  async getRatingSummary(productId: number) {
    const result = await this.dataSource
      .getRepository(ProductReview)
      .createQueryBuilder('review')
      .select('ROUND(AVG(review.rating)::numeric, 2)', 'averageRating')
      .addSelect('COUNT(*)::int', 'reviewCount')
      .where('review.productId = :productId', { productId })
      .andWhere('review.isVisible = true')
      .getRawOne<{ averageRating: string | null; reviewCount: number }>();
    return {
      averageRating:
        result?.averageRating === null || result?.averageRating === undefined
          ? null
          : Number(result.averageRating),
      reviewCount: Number(result?.reviewCount ?? 0),
    };
  }

  private hasDeliveredPurchase(userId: number, productId: number) {
    return this.dataSource
      .getRepository(OrderItem)
      .createQueryBuilder('item')
      .innerJoin('item.order', 'order')
      .innerJoin('item.variant', 'variant')
      .where('order.userId = :userId', { userId })
      .andWhere('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('variant.productId = :productId', { productId })
      .getExists();
  }

  private toReviewResponse(review: ProductReview, includeVisibility = false) {
    const { id, rating, title, body, createdAt, updatedAt, isVisible } = review;
    return {
      id,
      rating,
      title,
      body,
      createdAt,
      updatedAt,
      ...(includeVisibility ? { isVisible } : {}),
    };
  }
}
