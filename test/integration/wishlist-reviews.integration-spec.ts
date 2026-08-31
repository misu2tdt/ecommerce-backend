import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { Brand } from '../../src/brands/entities/brand.entity';
import { CartItem } from '../../src/carts/entities/cart-item.entity';
import { Category } from '../../src/categories/entities/category.entity';
import { ImageStorageService } from '../../src/image-storage/image-storage.service';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { OrdersService } from '../../src/orders/orders.service';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductsService } from '../../src/products/products.service';
import { ProductReview } from '../../src/reviews/entities/product-review.entity';
import { ProductReviewsService } from '../../src/reviews/product-reviews.service';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import { WishlistItem } from '../../src/wishlist/entities/wishlist-item.entity';
import { WishlistService } from '../../src/wishlist/wishlist.service';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Wishlist and verified Product reviews PostgreSQL integration', () => {
  let dataSource: DataSource;
  let wishlist: WishlistService;
  let reviews: ProductReviewsService;
  let orders: OrdersService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    wishlist = new WishlistService(dataSource);
    reviews = new ProductReviewsService(dataSource);
    const promotions = new PromotionsService(dataSource);
    orders = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as TelegramService,
      promotions,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('keeps concurrent duplicate Wishlist adds unique without side effects', async () => {
    const user = await createUser('wishlist-concurrent');
    const { product, variant } = await setupProduct(
      'wishlist-concurrent',
      4,
      150_000,
    );
    await Promise.all([
      wishlist.add(user.id, product.id),
      wishlist.add(user.id, product.id),
    ]);
    await expect(dataSource.getRepository(WishlistItem).count()).resolves.toBe(
      1,
    );
    expect(await stockOf(variant.id)).toBe(4);
    await expect(dataSource.getRepository(CartItem).count()).resolves.toBe(0);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
  });

  it('enforces Wishlist ownership and retains inactive Product availability', async () => {
    const owner = await createUser('wishlist-owner');
    const other = await createUser('wishlist-other');
    const { product } = await setupProduct('wishlist-owner', 2, 120_000);
    await wishlist.add(owner.id, product.id);
    await expect(wishlist.remove(other.id, product.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await dataSource.getRepository(Product).update(product.id, {
      status: ProductStatus.INACTIVE,
    });
    const saved = await wishlist.findAll(owner.id);
    expect(saved).toHaveLength(1);
    expect(saved[0].product).toEqual(
      expect.objectContaining({
        status: ProductStatus.INACTIVE,
        available: false,
        minPrice: 120_000,
        maxPrice: 120_000,
        inStock: true,
      }),
    );
  });

  it('allows only a delivered purchaser to create one Product review', async () => {
    const deliveredUser = await createUser('review-delivered');
    const pendingUser = await createUser('review-pending');
    const { product, variant } = await setupProduct(
      'review-eligibility',
      5,
      200_000,
    );
    await checkoutAndDeliver(deliveredUser, variant);
    await checkout(pendingUser, variant);

    const review = await reviews.create(deliveredUser.id, product.id, {
      rating: 5,
      title: 'Excellent',
    });
    expect(review.rating).toBe(5);
    await expect(
      reviews.create(pendingUser.id, product.id, { rating: 4 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      reviews.create(deliveredUser.id, product.id, { rating: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      dataSource.getRepository(ProductReview).save({
        userId: deliveredUser.id,
        productId: product.id,
        rating: 3,
        title: null,
        body: null,
        isVisible: true,
      }),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('enforces the database rating CHECK independently of DTO validation', async () => {
    const user = await createUser('review-check');
    const { product } = await setupProduct('review-check', 1, 100_000);
    await expect(
      dataSource.getRepository(ProductReview).save({
        userId: user.id,
        productId: product.id,
        rating: 0,
        title: null,
        body: null,
        isVisible: true,
      }),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('excludes hidden reviews from public read and Product rating summary', async () => {
    const firstUser = await createUser('review-summary-a');
    const secondUser = await createUser('review-summary-b');
    const { product, variant } = await setupProduct(
      'review-summary',
      5,
      200_000,
    );
    await checkoutAndDeliver(firstUser, variant);
    await checkoutAndDeliver(secondUser, variant);
    const first = await reviews.create(firstUser.id, product.id, { rating: 5 });
    const second = await reviews.create(secondUser.id, product.id, {
      rating: 3,
    });
    await reviews.setVisibility(second.id, false);

    const visible = await reviews.findPublic(product.id);
    expect(visible.map(({ id }) => id)).toEqual([first.id]);
    await expect(reviews.getRatingSummary(product.id)).resolves.toEqual({
      averageRating: 5,
      reviewCount: 1,
    });
    const products = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(Category),
      dataSource.getRepository(Brand),
      dataSource.getRepository(ProductImage),
      { deleteImage: jest.fn() } as unknown as ImageStorageService,
    );
    await expect(products.findBySlug(product.slug)).resolves.toEqual(
      expect.objectContaining({ averageRating: 5, reviewCount: 1 }),
    );
  });

  async function createUser(suffix: string) {
    return dataSource.getRepository(User).save({
      email: `${suffix}@example.test`,
      password: 'hash',
      role: UserRole.USER,
    });
  }

  async function setupProduct(suffix: string, stock: number, price: number) {
    const category = await createCategory(dataSource, suffix);
    const product = await dataSource.getRepository(Product).save({
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      description: null,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: null,
    });
    const variant = await createVariant(dataSource, product, suffix, {
      stock,
      price,
    });
    return { product, variant };
  }

  async function checkout(user: User, variant: ProductVariant) {
    const address = await createAddress(dataSource, user, `review-${user.id}`);
    return orders.checkout(user.id, {
      addressId: address.id,
      items: [{ variantId: variant.id, quantity: 1 }],
    });
  }

  async function checkoutAndDeliver(user: User, variant: ProductVariant) {
    const order = await checkout(user, variant);
    await orders.updateStatus(order.id, OrderStatus.CONFIRMED);
    await orders.updateStatus(order.id, OrderStatus.PROCESSING);
    await orders.updateStatus(order.id, OrderStatus.SHIPPED);
    await orders.updateStatus(order.id, OrderStatus.DELIVERED);
    return order;
  }

  async function stockOf(variantId: number) {
    return (
      await dataSource
        .getRepository(ProductVariant)
        .findOneByOrFail({ id: variantId })
    ).stock;
  }
});
