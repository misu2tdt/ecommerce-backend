import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { Address } from '../../src/addresses/entities/address.entity';
import { Brand } from '../../src/brands/entities/brand.entity';
import { CartItem } from '../../src/carts/entities/cart-item.entity';
import { Cart } from '../../src/carts/entities/cart.entity';
import { Category } from '../../src/categories/entities/category.entity';
import {
  DEMO_ADDRESS_LABEL,
  DEMO_ADMIN_EMAIL,
  DEMO_CUSTOMER_EMAIL,
  DEMO_ORDER_MARKER,
  DEMO_PASSWORD,
  LEGACY_DEMO_ADDRESS_LABEL,
  LEGACY_DEMO_ORDER_MARKER,
  LEGACY_PRODUCT_SLUGS,
  LEGACY_VARIANT_SKUS,
  seedDemoData,
} from '../../src/database/seeds/demo-seed';
import { PRODUCTION_DEMO_CONFIRMATION } from '../../src/database/seeds/demo-seed-safety';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { OrderStatus } from '../../src/orders/entities/order-status.enum';
import { Order } from '../../src/orders/entities/order.entity';
import { snapshotShippingAddress } from '../../src/orders/shipping-address';
import { Payment } from '../../src/payments/entities/payment.entity';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductVariant } from '../../src/products/entities/product-variant.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductReview } from '../../src/reviews/entities/product-review.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { WishlistItem } from '../../src/wishlist/entities/wishlist-item.entity';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const categorySlugs = [
  't-shirts-tops',
  'shirts-polos',
  'hoodies-outerwear',
  'pants-shorts',
  'basics-accessories',
];
const brandSlugs = [
  'aerothread',
  'kanso-basics',
  'veloce-active',
  'monolith-studio',
];
const productSlugs = [
  'classic-crewneck-cotton-tee',
  'heavyweight-boxy-pocket-tee',
  'seamless-performance-training-tee',
  'waffle-knit-long-sleeve-tee',
  'supima-modal-oversized-tee',
  'breathable-mesh-running-singlet',
  'classic-pique-cotton-polo',
  'tech-knit-zipper-polo',
  'relaxed-oxford-button-down-shirt',
  'linen-short-sleeve-resort-shirt',
  'structured-workwear-overshirt',
  'french-terry-full-zip-hoodie',
  'heavyweight-pullover-sweatshirt',
  'packable-trail-windbreaker',
  'minimalist-technical-bomber-jacket',
  'water-resistant-commuter-parka',
  'everyday-stretch-chino-pants',
  'comfort-drawstring-jogger-pants',
  'active-training-7-inch-shorts',
  'ripstop-utility-cargo-shorts',
  'tailored-pleated-easy-trousers',
  'bamboo-fiber-boxer-briefs-3-pack',
  'seamless-modal-trunks-2-pack',
  'cushioned-cotton-crew-socks-3-pack',
  'heavy-canvas-daily-tote-bag',
  'lightweight-ripstop-running-cap',
];
const variantSkus = [
  'AT-CCT-BLK-M',
  'AT-CCT-BLK-L',
  'AT-CCT-WHT-M',
  'AT-HBT-OAT-M',
  'AT-HBT-OAT-L',
  'AT-HBT-SGE-L',
  'VA-SPT-CHR-M',
  'VA-SPT-CHR-L',
  'VA-SPT-NVY-XL',
  'KB-WLT-SND-M',
  'KB-WLT-SND-L',
  'KB-WLT-BLK-L',
  'KB-SMT-IVO-S',
  'KB-SMT-IVO-M',
  'KB-SMT-CLD-L',
  'VA-BMS-COR-M',
  'VA-BMS-COR-L',
  'VA-BMS-BLK-L',
  'AT-PCP-NVY-M',
  'AT-PCP-NVY-L',
  'AT-PCP-WHT-L',
  'VA-TZP-OLV-M',
  'VA-TZP-OLV-L',
  'VA-TZP-BLK-XL',
  'AT-ROB-LBL-M',
  'AT-ROB-LBL-L',
  'AT-ROB-WHT-L',
  'MS-LRS-BEI-M',
  'MS-LRS-BEI-L',
  'MS-LRS-TER-L',
  'MS-SWO-KHK-M',
  'MS-SWO-KHK-L',
  'MS-SWO-BLK-L',
  'AT-FZH-HGR-M',
  'AT-FZH-HGR-L',
  'AT-FZH-BLK-L',
  'KB-HPS-FOR-M',
  'KB-HPS-FOR-L',
  'KB-HPS-BLK-XL',
  'VA-PTW-CYN-M',
  'VA-PTW-CYN-L',
  'VA-PTW-BLK-L',
  'MS-MTB-DGR-M',
  'MS-MTB-DGR-L',
  'MS-MTB-BLK-L',
  'MS-WCP-OLV-M',
  'MS-WCP-OLV-L',
  'AT-ESC-KHK-30',
  'AT-ESC-KHK-32',
  'AT-ESC-NVY-32',
  'KB-CDJ-GRY-M',
  'KB-CDJ-GRY-L',
  'KB-CDJ-BLK-L',
  'VA-ATS-BLK-M',
  'VA-ATS-BLK-L',
  'VA-ATS-NVY-L',
  'MS-RCS-SND-M',
  'MS-RCS-SND-L',
  'MS-RCS-OLV-L',
  'MS-TET-CHR-30',
  'MS-TET-CHR-32',
  'KB-BBB-AST-M',
  'KB-BBB-AST-L',
  'KB-BBB-AST-XL',
  'KB-SMT-BLK-M',
  'KB-SMT-BLK-L',
  'AT-CCS-WHT-OS',
  'AT-CCS-BLK-OS',
  'AT-CDT-NAT-OS',
  'AT-CDT-BLK-OS',
  'VA-RRC-BLK-OS',
  'VA-RRC-SLV-OS',
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
      categories: 5,
      brands: 4,
      products: 26,
      variants: 72,
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

  it('safely upgrades an existing production database containing legacy demo data and unrelated ADMIN', async () => {
    // 1. Arrange legacy Phase 3B electronics dataset
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const customer = await dataSource.getRepository(User).save({
      email: DEMO_CUSTOMER_EMAIL,
      password: passwordHash,
      role: UserRole.USER,
    });

    const operatorPassword = randomBytes(32).toString('base64url');
    const operatorPasswordHash = await bcrypt.hash(operatorPassword, 10);
    const operatorAdmin = await dataSource.getRepository(User).save({
      email: 'operator.admin@example.com',
      password: operatorPasswordHash,
      role: UserRole.ADMIN,
    });

    const legacyCatLaptops = await dataSource.getRepository(Category).save({
      name: 'Demo Laptops',
      slug: 'demo-laptops',
      description: 'Fictional portable computers',
    });
    const legacyCatPhones = await dataSource.getRepository(Category).save({
      name: 'Demo Smartphones',
      slug: 'demo-smartphones',
      description: 'Fictional smartphones',
    });

    const legacyBrandNova = await dataSource.getRepository(Brand).save({
      name: 'Nova Demo Technologies',
      slug: 'nova-demo-technologies',
      description: 'Fictional tech brand',
    });
    const legacyBrandAster = await dataSource.getRepository(Brand).save({
      name: 'Aster Demo Devices',
      slug: 'aster-demo-devices',
      description: 'Fictional mobile brand',
    });

    const legacyProdAir = await dataSource.getRepository(Product).save({
      name: 'Demo NovaBook Air',
      slug: 'demo-novabook-air',
      description: 'Fictional notebook',
      status: ProductStatus.ACTIVE,
      categoryId: legacyCatLaptops.id,
      brandId: legacyBrandNova.id,
    });
    const legacyProdPro = await dataSource.getRepository(Product).save({
      name: 'Demo NovaBook Pro',
      slug: 'demo-novabook-pro',
      description: 'Fictional performance notebook',
      status: ProductStatus.ACTIVE,
      categoryId: legacyCatLaptops.id,
      brandId: legacyBrandNova.id,
    });
    const legacyProdPhone = await dataSource.getRepository(Product).save({
      name: 'Demo Aster Phone X',
      slug: 'demo-aster-phone-x',
      description: 'Fictional phone',
      status: ProductStatus.ACTIVE,
      categoryId: legacyCatPhones.id,
      brandId: legacyBrandAster.id,
    });

    const legacyVarAir8 = await dataSource.getRepository(ProductVariant).save({
      productId: legacyProdAir.id,
      sku: 'DEMO-NBA-8-256',
      name: '8 GB / 256 GB / Silver',
      price: 15990000,
      stock: 12,
      attributes: { ram: '8GB', storage: '256GB' },
      isActive: true,
      position: 0,
    });
    await dataSource.getRepository(ProductVariant).save({
      productId: legacyProdAir.id,
      sku: 'DEMO-NBA-16-512',
      name: '16 GB / 512 GB / Midnight',
      price: 18990000,
      stock: 8,
      attributes: { ram: '16GB', storage: '512GB' },
      isActive: true,
      position: 1,
    });
    const legacyVarPro16 = await dataSource.getRepository(ProductVariant).save({
      productId: legacyProdPro.id,
      sku: 'DEMO-NBP-16-512',
      name: '16 GB / 512 GB / Graphite',
      price: 21990000,
      stock: 6,
      attributes: { ram: '16GB', storage: '512GB' },
      isActive: true,
      position: 0,
    });
    await dataSource.getRepository(ProductVariant).save({
      productId: legacyProdPro.id,
      sku: 'DEMO-NBP-32-1TB',
      name: '32 GB / 1 TB / Graphite',
      price: 24990000,
      stock: 0,
      attributes: { ram: '32GB', storage: '1TB' },
      isActive: true,
      position: 1,
    });
    const legacyVarPhone128 = await dataSource
      .getRepository(ProductVariant)
      .save({
        productId: legacyProdPhone.id,
        sku: 'DEMO-APX-128',
        name: '128 GB / Aurora Blue',
        price: 12990000,
        stock: 20,
        attributes: { storage: '128GB' },
        isActive: true,
        position: 0,
      });
    await dataSource.getRepository(ProductVariant).save({
      productId: legacyProdPhone.id,
      sku: 'DEMO-APX-256',
      name: '256 GB / Aurora Blue',
      price: 14990000,
      stock: 14,
      attributes: { storage: '256GB' },
      isActive: true,
      position: 1,
    });
    await dataSource.getRepository(ProductVariant).save({
      productId: legacyProdPhone.id,
      sku: 'DEMO-APX-512',
      name: '512 GB / Eclipse Black',
      price: 16990000,
      stock: 5,
      attributes: { storage: '512GB' },
      isActive: true,
      position: 2,
    });

    const legacyAddress = await dataSource.getRepository(Address).save({
      userId: customer.id,
      label: LEGACY_DEMO_ADDRESS_LABEL,
      recipientName: 'Demo Customer',
      phone: '+84900000000',
      addressLine1: '100 Demo Avenue',
      addressLine2: LEGACY_DEMO_ORDER_MARKER,
      ward: 'Demo Ward',
      district: 'Demo District',
      city: 'Ho Chi Minh City',
      postalCode: '700000',
      countryCode: 'VN',
      isDefault: false,
    });

    const legacyCart = await dataSource
      .getRepository(Cart)
      .save({ userId: customer.id });
    await dataSource.getRepository(CartItem).save([
      { cartId: legacyCart.id, variantId: legacyVarPro16.id, quantity: 1 },
      { cartId: legacyCart.id, variantId: legacyVarPhone128.id, quantity: 2 },
    ]);

    await dataSource.getRepository(WishlistItem).save({
      userId: customer.id,
      productId: legacyProdAir.id,
    });

    const legacyOrder = await dataSource.getRepository(Order).save({
      userId: customer.id,
      totalPrice: legacyVarAir8.price,
      status: OrderStatus.DELIVERED,
      shippingAddress: snapshotShippingAddress(legacyAddress),
    });

    const legacyOrderItem = await dataSource.getRepository(OrderItem).save({
      orderId: legacyOrder.id,
      variantId: legacyVarAir8.id,
      quantity: 1,
      price: legacyVarAir8.price,
    });

    const legacyReview = await dataSource.getRepository(ProductReview).save({
      userId: customer.id,
      productId: legacyProdAir.id,
      rating: 5,
      title: 'Great demo product',
      body: 'A fictional review backed by the delivered demo Order.',
      isVisible: true,
    });

    // Capture before-upgrade identities and values
    const beforeOrderId = legacyOrder.id;
    const beforeOrderTotal = legacyOrder.totalPrice;
    const beforeOrderShipping = legacyOrder.shippingAddress;
    const beforeOrderItemId = legacyOrderItem.id;
    const beforeOrderItemVariantId = legacyOrderItem.variantId;
    const beforeOrderItemPrice = legacyOrderItem.price;
    const beforeReviewId = legacyReview.id;
    const beforeReviewTitle = legacyReview.title;
    const beforeAdminId = operatorAdmin.id;
    const beforeAdminPassword = operatorAdmin.password;

    // 2. Run Phase 6A production seed ONCE
    const prodOptions = {
      target: 'production' as const,
      nodeEnvironment: 'production',
      productionApproval: {
        confirmation: PRODUCTION_DEMO_CONFIRMATION,
        database: 'ecommerce_test',
      },
    };

    const firstRunSummary = await seedDemoData(dataSource, prodOptions);
    expect(firstRunSummary.categories).toBe(5);
    expect(firstRunSummary.brands).toBe(4);
    expect(firstRunSummary.products).toBe(26);
    expect(firstRunSummary.variants).toBe(72);
    expect(firstRunSummary.users).toBe(1);

    // Assert: Legacy products are retired (status = INACTIVE)
    const retiredProducts = await dataSource.getRepository(Product).findBy({
      slug: In(LEGACY_PRODUCT_SLUGS),
    });
    expect(retiredProducts).toHaveLength(3);
    for (const p of retiredProducts) {
      expect(p.status).toBe(ProductStatus.INACTIVE);
    }

    // Assert: Legacy variants are retired (isActive = false)
    const retiredVariants = await dataSource
      .getRepository(ProductVariant)
      .findBy({
        sku: In(LEGACY_VARIANT_SKUS),
      });
    expect(retiredVariants).toHaveLength(7);
    for (const v of retiredVariants) {
      expect(v.isActive).toBe(false);
    }

    // Assert: Legacy cart and wishlist items for demo customer are cleaned up
    const remainingLegacyCartItems = await dataSource
      .getRepository(CartItem)
      .countBy({
        cartId: legacyCart.id,
        variantId: In(retiredVariants.map((v) => v.id)),
      });
    expect(remainingLegacyCartItems).toBe(0);

    const remainingLegacyWishlist = await dataSource
      .getRepository(WishlistItem)
      .countBy({
        userId: customer.id,
        productId: In(retiredProducts.map((p) => p.id)),
      });
    expect(remainingLegacyWishlist).toBe(0);

    // Assert: New Phase 6A fashion cart & wishlist items exist
    const fashionVariants = await dataSource
      .getRepository(ProductVariant)
      .findBy({
        sku: In(variantSkus),
      });
    expect(fashionVariants).toHaveLength(72);

    const fashionCartItems = await dataSource.getRepository(CartItem).findBy({
      cartId: legacyCart.id,
    });
    expect(fashionCartItems).toHaveLength(2);

    const fashionWishlistItems = await dataSource
      .getRepository(WishlistItem)
      .findBy({
        userId: customer.id,
      });
    expect(fashionWishlistItems).toHaveLength(1);

    // Assert: Legacy Order & OrderItem remain completely unchanged
    const afterLegacyOrder = await dataSource
      .getRepository(Order)
      .findOneByOrFail({
        id: beforeOrderId,
      });
    expect(afterLegacyOrder.totalPrice).toBe(beforeOrderTotal);
    expect(afterLegacyOrder.shippingAddress).toEqual(beforeOrderShipping);
    expect(afterLegacyOrder.status).toBe(OrderStatus.DELIVERED);

    const afterLegacyOrderItem = await dataSource
      .getRepository(OrderItem)
      .findOneByOrFail({
        id: beforeOrderItemId,
      });
    expect(afterLegacyOrderItem.variantId).toBe(beforeOrderItemVariantId);
    expect(afterLegacyOrderItem.price).toBe(beforeOrderItemPrice);

    // Assert: Legacy review is preserved
    const afterLegacyReview = await dataSource
      .getRepository(ProductReview)
      .findOneByOrFail({
        id: beforeReviewId,
      });
    expect(afterLegacyReview.title).toBe(beforeReviewTitle);
    expect(afterLegacyReview.productId).toBe(legacyProdAir.id);

    // Assert: Unrelated ADMIN is unchanged
    const afterAdmin = await dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.id = :id', { id: beforeAdminId })
      .getOneOrFail();
    expect(afterAdmin.role).toBe(UserRole.ADMIN);
    expect(afterAdmin.password).toBe(beforeAdminPassword);

    // Assert: New Phase 6A Order & Review exist
    const phase6AOrders = await dataSource.getRepository(Order).find({
      where: { userId: customer.id },
    });
    expect(phase6AOrders).toHaveLength(2); // 1 legacy + 1 phase 6A

    const phase6AOrder = phase6AOrders.find(
      (o) => o.shippingAddress?.addressLine2 === DEMO_ORDER_MARKER,
    );
    expect(phase6AOrder).toBeDefined();
    expect(phase6AOrder!.totalPrice).toBe(199000);

    const phase6AReviews = await dataSource.getRepository(ProductReview).find({
      where: { userId: customer.id },
    });
    expect(phase6AReviews).toHaveLength(2); // 1 legacy + 1 phase 6A

    // 3. Run Phase 6A seed a SECOND time (Idempotency)
    const secondRunSummary = await seedDemoData(dataSource, prodOptions);
    expect(secondRunSummary).toEqual(firstRunSummary);

    // Assert: No duplicates created
    const totalFashionProds = await dataSource.getRepository(Product).countBy({
      slug: In(productSlugs),
    });
    expect(totalFashionProds).toBe(26);

    const totalFashionVariants = await dataSource
      .getRepository(ProductVariant)
      .countBy({
        sku: In(variantSkus),
      });
    expect(totalFashionVariants).toBe(72);

    const totalCartItemsAfter = await dataSource
      .getRepository(CartItem)
      .countBy({
        cartId: legacyCart.id,
      });
    expect(totalCartItemsAfter).toBe(2);

    const totalWishlistAfter = await dataSource
      .getRepository(WishlistItem)
      .countBy({
        userId: customer.id,
      });
    expect(totalWishlistAfter).toBe(1);

    const totalOrdersAfter = await dataSource.getRepository(Order).countBy({
      userId: customer.id,
    });
    expect(totalOrdersAfter).toBe(2);

    const totalReviewsAfter = await dataSource
      .getRepository(ProductReview)
      .countBy({
        userId: customer.id,
      });
    expect(totalReviewsAfter).toBe(2);

    // Verify legacy order, items, review, ADMIN, and verified purchase invariant after second run
    const finalLegacyOrder = await dataSource
      .getRepository(Order)
      .findOneByOrFail({
        id: beforeOrderId,
      });
    expect(finalLegacyOrder.totalPrice).toBe(beforeOrderTotal);
    expect(finalLegacyOrder.shippingAddress).toEqual(beforeOrderShipping);
    expect(finalLegacyOrder.status).toBe(OrderStatus.DELIVERED);

    const finalLegacyOrderItem = await dataSource
      .getRepository(OrderItem)
      .findOneByOrFail({
        id: beforeOrderItemId,
      });
    expect(finalLegacyOrderItem.variantId).toBe(beforeOrderItemVariantId);
    expect(finalLegacyOrderItem.price).toBe(beforeOrderItemPrice);

    const finalLegacyReview = await dataSource
      .getRepository(ProductReview)
      .findOneByOrFail({
        id: beforeReviewId,
      });
    expect(finalLegacyReview.title).toBe(beforeReviewTitle);
    expect(finalLegacyReview.productId).toBe(legacyProdAir.id);

    const finalAdmin = await dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.id = :id', { id: beforeAdminId })
      .getOneOrFail();
    expect(finalAdmin.role).toBe(UserRole.ADMIN);
    expect(finalAdmin.password).toBe(beforeAdminPassword);

    const legacyVerifiedPurchase = await dataSource
      .getRepository(OrderItem)
      .createQueryBuilder('item')
      .innerJoin('item.order', 'order')
      .innerJoin('item.variant', 'variant')
      .where('order.userId = :userId', { userId: customer.id })
      .andWhere('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('variant.productId = :productId', {
        productId: finalLegacyReview.productId,
      })
      .getExists();
    expect(legacyVerifiedPurchase).toBe(true);
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
    productId: products.find(
      (product) => product.slug === 'classic-crewneck-cotton-tee',
    )?.id,
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
      label: DEMO_ADDRESS_LABEL,
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
