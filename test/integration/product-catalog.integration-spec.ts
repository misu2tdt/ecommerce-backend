import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Brand } from '../../src/brands/entities/brand.entity';
import { Category } from '../../src/categories/entities/category.entity';
import { ImageStorageService } from '../../src/image-storage/image-storage.service';
import { OrdersService } from '../../src/orders/orders.service';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { Order } from '../../src/orders/entities/order.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductVariantsService } from '../../src/products/product-variants.service';
import { ProductsService } from '../../src/products/products.service';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import {
  createAddress,
  createCategory,
  createVariant,
} from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Product variant catalog PostgreSQL integration', () => {
  let dataSource: DataSource;
  let products: ProductsService;
  let variants: ProductVariantsService;
  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    products = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(Category),
      dataSource.getRepository(Brand),
      dataSource.getRepository(ProductImage),
      { deleteImage: jest.fn() } as unknown as ImageStorageService,
    );
    variants = new ProductVariantsService(
      dataSource.getRepository(ProductVariant),
      dataSource.getRepository(Product),
    );
  });
  beforeEach(async () => cleanTestDatabase(dataSource));
  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('persists multiple variants and enforces globally unique normalized SKU', async () => {
    const category = await createCategory(dataSource, 'variants');
    const product = await products.create({
      name: 'Variant Product',
      categoryId: category.id,
    });
    const first = await variants.createForProduct(product.id, {
      sku: ' sku-black ',
      name: 'Black',
      price: 1_000_000,
      stock: 2,
      attributes: { color: 'Black' },
    });
    await variants.createForProduct(product.id, {
      sku: 'SKU-WHITE',
      name: 'White',
      price: 1_200_000,
      stock: 3,
    });
    expect(first.sku).toBe('SKU-BLACK');
    await expect(
      variants.createForProduct(product.id, {
        sku: 'sku-black',
        name: 'Duplicate',
        price: 10_000,
        stock: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      dataSource
        .getRepository(ProductVariant)
        .countBy({ productId: product.id }),
    ).resolves.toBe(2);
  });

  it('returns variant price summary and only active variants in detail', async () => {
    const category = await createCategory(dataSource, 'summary');
    const product = await products.create({
      name: 'Summary Product',
      categoryId: category.id,
    });
    await createVariant(dataSource, product, 'summary-a', {
      price: 1_000_000,
      stock: 0,
      position: 10,
    });
    const active = await createVariant(dataSource, product, 'summary-b', {
      price: 800_000,
      stock: 2,
      position: 0,
    });
    await createVariant(dataSource, product, 'summary-hidden', {
      price: 10_000,
      stock: 99,
      isActive: false,
    });
    const [listed] = await products.findAll({ category: category.slug });
    expect(listed).toEqual(
      expect.objectContaining({
        minPrice: 800_000,
        maxPrice: 1_000_000,
        inStock: true,
      }),
    );
    const detail = await products.findBySlug(product.slug);
    expect(detail.variants?.map((item) => item.id)).toEqual([
      active.id,
      expect.any(Number),
    ]);
    expect(detail.variants).toHaveLength(2);
  });

  it('rejects inactive Variant and inactive Product checkout without writes', async () => {
    const category = await createCategory(dataSource, 'inactive');
    const product = await products.create({
      name: 'Inactive Parent',
      categoryId: category.id,
      status: ProductStatus.INACTIVE,
    });
    const variant = await createVariant(dataSource, product, 'inactive', {
      stock: 4,
    });
    const user = await dataSource.getRepository(User).save({
      email: 'inactive@example.test',
      password: 'hash',
      role: UserRole.USER,
    });
    const address = await createAddress(dataSource, user, 'inactive');
    const promotions = new PromotionsService(dataSource);
    const service = new OrdersService(
      dataSource,
      {
        sendMessage: jest.fn(),
      } as unknown as TelegramService,
      promotions,
    );
    await expect(
      service.checkout(user.id, {
        addressId: address.id,
        items: [{ variantId: variant.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      (
        await dataSource
          .getRepository(ProductVariant)
          .findOneByOrFail({ id: variant.id })
      ).stock,
    ).toBe(4);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
    await expect(dataSource.getRepository(OrderItem).count()).resolves.toBe(0);
  });
});
