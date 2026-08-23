import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { Address } from '../../src/addresses/entities/address.entity';
import { Brand } from '../../src/brands/entities/brand.entity';
import { CartItem } from '../../src/carts/entities/cart-item.entity';
import { Cart } from '../../src/carts/entities/cart.entity';
import { Category } from '../../src/categories/entities/category.entity';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_CUSTOMER_EMAIL,
  DEMO_PASSWORD,
  seedDemoData,
} from '../../src/database/seeds/demo-seed';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { Payment } from '../../src/payments/entities/payment.entity';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductReview } from '../../src/reviews/entities/product-review.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { WishlistItem } from '../../src/wishlist/entities/wishlist-item.entity';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const categorySlugs = ['demo-laptops', 'demo-smartphones'];
const brandSlugs = ['nova-demo-technologies', 'aster-demo-devices'];
const productSlugs = [
  'demo-novabook-air',
  'demo-novabook-pro',
  'demo-aster-phone-x',
];
const variantSkus = [
  'DEMO-NBA-8-256',
  'DEMO-NBA-16-512',
  'DEMO-NBP-16-512',
  'DEMO-NBP-32-1TB',
  'DEMO-APX-128',
  'DEMO-APX-256',
  'DEMO-APX-512',
];

describe('deterministic demo seed on isolated PostgreSQL', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('creates coherent data and a second run does not duplicate it', async () => {
    const first = await seedDemoData(dataSource, {
      target: 'test',
      nodeEnvironment: 'test',
    });
    const firstSnapshot = await demoSnapshot(dataSource);

    const second = await seedDemoData(dataSource, {
      target: 'test',
      nodeEnvironment: 'test',
    });
    const secondSnapshot = await demoSnapshot(dataSource);

    expect(second).toEqual(first);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot).toEqual({
      users: 2,
      categories: 2,
      brands: 2,
      products: 3,
      variants: 7,
      addresses: 1,
      carts: 1,
      cartItems: 2,
      wishlistItems: 1,
      deliveredOrders: 1,
      orderItems: 1,
      reviews: 1,
      payments: 0,
      verifiedReviewPurchase: true,
    });
  });

  it('seeds production portfolio data twice without creating a known ADMIN', async () => {
    const options = {
      target: 'production' as const,
      nodeEnvironment: 'production',
      productionApproval: {
        confirmation: PRODUCTION_DEMO_CONFIRMATION,
        database: 'ecommerce_test',
      },
    };

    const first = await seedDemoData(dataSource, options);
    const firstSnapshot = await demoSnapshot(dataSource);
    const second = await seedDemoData(dataSource, options);
    const secondSnapshot = await demoSnapshot(dataSource);

    expect(second).toEqual(first);
    expect(first.users).toBe(1);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot.users).toBe(1);
    expect(
      await dataSource.getRepository(User).findOneBy({
        email: DEMO_ADMIN_EMAIL,
      }),
    ).toBeNull();
    expect(
      await dataSource.getRepository(User).countBy({ role: UserRole.ADMIN }),
    ).toBe(0);
  });

  it('does not modify a separately provisioned ADMIN account', async () => {
    const repository = dataSource.getRepository(User);
    const operatorPassword = randomBytes(32).toString('base64url');
    const password = await bcrypt.hash(operatorPassword, 10);
    await repository.save(
      repository.create({
        email: DEMO_ADMIN_EMAIL,
        password,
        role: UserRole.ADMIN,
      }),
    );

    await seedDemoData(dataSource, {
      target: 'production',
      nodeEnvironment: 'production',
      productionApproval: {
        confirmation: PRODUCTION_DEMO_CONFIRMATION,
        database: 'ecommerce_test',
      },
    });

    const admin = await repository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email: DEMO_ADMIN_EMAIL })
      .getOneOrFail();
    expect(admin.role).toBe(UserRole.ADMIN);
    expect(admin.password).toBe(password);
    expect(await bcrypt.compare(operatorPassword, admin.password)).toBe(true);
    expect(await bcrypt.compare(DEMO_PASSWORD, admin.password)).toBe(false);
  });

  it('refuses to overwrite a privileged account at the customer demo email', async () => {
    const repository = dataSource.getRepository(User);
    const password = await bcrypt.hash(
      randomBytes(32).toString('base64url'),
      10,
    );
    await repository.save(
      repository.create({
        email: DEMO_CUSTOMER_EMAIL,
        password,
        role: UserRole.ADMIN,
      }),
    );

    await expect(
      seedDemoData(dataSource, {
        target: 'production',
        nodeEnvironment: 'production',
        productionApproval: {
          confirmation: PRODUCTION_DEMO_CONFIRMATION,
          database: 'ecommerce_test',
        },
      }),
    ).rejects.toThrow('refuses to modify an existing privileged account');

    const admin = await repository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email: DEMO_CUSTOMER_EMAIL })
      .getOneOrFail();
    expect(admin.role).toBe(UserRole.ADMIN);
    expect(admin.password).toBe(password);
  });
});

async function demoSnapshot(dataSource: DataSource) {
  const userRepository = dataSource.getRepository(User);
  const customer = await userRepository.findOneByOrFail({
    email: DEMO_CUSTOMER_EMAIL,
  });
  const demoUsers = await userRepository.countBy({
    email: In([DEMO_CUSTOMER_EMAIL, DEMO_ADMIN_EMAIL]),
  });
  const products = await dataSource.getRepository(Product).findBy({
    slug: In(productSlugs),
  });
  const variants = await dataSource.getRepository(ProductVariant).findBy({
    sku: In(variantSkus),
  });
  const cart = await dataSource
    .getRepository(Cart)
    .findOneByOrFail({ userId: customer.id });
  const deliveredOrders = await dataSource.getRepository(Order).find({
    where: { userId: customer.id, status: OrderStatus.DELIVERED },
  });
  const review = await dataSource.getRepository(ProductReview).findOneBy({
    userId: customer.id,
    productId: products.find((product) => product.slug === 'demo-novabook-air')
      ?.id,
  });
  const verifiedReviewPurchase = review
    ? await dataSource
        .getRepository(OrderItem)
        .createQueryBuilder('item')
        .innerJoin('item.order', 'order')
        .innerJoin('item.variant', 'variant')
        .where('order.userId = :userId', { userId: customer.id })
        .andWhere('order.status = :status', { status: OrderStatus.DELIVERED })
        .andWhere('variant.productId = :productId', {
          productId: review.productId,
        })
        .getExists()
    : false;

  return {
    users: demoUsers,
    categories: await dataSource.getRepository(Category).countBy({
      slug: In(categorySlugs),
    }),
    brands: await dataSource.getRepository(Brand).countBy({
      slug: In(brandSlugs),
    }),
    products: products.length,
    variants: variants.length,
    addresses: await dataSource.getRepository(Address).countBy({
      userId: customer.id,
      label: 'Phase 3B Demo Address',
    }),
    carts: 1,
    cartItems: await dataSource.getRepository(CartItem).countBy({
      cartId: cart.id,
      variantId: In(variants.map(({ id }) => id)),
    }),
    wishlistItems: await dataSource.getRepository(WishlistItem).countBy({
      userId: customer.id,
      productId: In(products.map(({ id }) => id)),
    }),
    deliveredOrders: deliveredOrders.length,
    orderItems: await dataSource.getRepository(OrderItem).countBy({
      orderId: In(deliveredOrders.map(({ id }) => id)),
    }),
    reviews: review ? 1 : 0,
    payments: await dataSource.getRepository(Payment).countBy({
      orderId: In(deliveredOrders.map(({ id }) => id)),
    }),
    verifiedReviewPurchase,
  };
}
