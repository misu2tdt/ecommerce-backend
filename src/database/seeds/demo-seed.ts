import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { Address } from '../../addresses/entities/address.entity';
import { Brand } from '../../brands/entities/brand.entity';
import { CartItem } from '../../carts/entities/cart-item.entity';
import { Cart } from '../../carts/entities/cart.entity';
import { createSlug } from '../../catalog/slug';
import { Category } from '../../categories/entities/category.entity';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { OrderStatus } from '../../orders/entities/order-status.enum';
import { Order } from '../../orders/entities/order.entity';
import { snapshotShippingAddress } from '../../orders/shipping-address';
import { ProductStatus } from '../../products/entities/product-status.enum';
import { ProductVariant } from '../../products/entities/product-variant.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductReview } from '../../reviews/entities/product-review.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import { User } from '../../users/entities/user.entity';
import { WishlistItem } from '../../wishlist/entities/wishlist-item.entity';
import { assertSafeDemoSeedDatabase, DemoSeedTarget } from './demo-seed-safety';

export const DEMO_CUSTOMER_EMAIL = 'demo.customer@example.com';
export const DEMO_ADMIN_EMAIL = 'demo.admin@example.com';
export const DEMO_PASSWORD = 'DemoOnly!2026';

const DEMO_ADDRESS_LABEL = 'Phase 3B Demo Address';
const DEMO_ORDER_MARKER = 'Phase 3B Demo Suite';
const BCRYPT_ROUNDS = 10;

const categoryDefinitions = [
  {
    name: 'Demo Laptops',
    description: 'Fictional portable computers for local demonstrations.',
  },
  {
    name: 'Demo Smartphones',
    description: 'Fictional smartphones for local demonstrations.',
  },
] as const;

const brandDefinitions = [
  {
    name: 'Nova Demo Technologies',
    description: 'A fictional development-only technology brand.',
  },
  {
    name: 'Aster Demo Devices',
    description: 'A fictional development-only mobile device brand.',
  },
] as const;

const productDefinitions = [
  {
    name: 'Demo NovaBook Air',
    description: 'A lightweight fictional notebook for storefront demos.',
    category: 'Demo Laptops',
    brand: 'Nova Demo Technologies',
  },
  {
    name: 'Demo NovaBook Pro',
    description: 'A fictional performance notebook for storefront demos.',
    category: 'Demo Laptops',
    brand: 'Nova Demo Technologies',
  },
  {
    name: 'Demo Aster Phone X',
    description: 'A fictional smartphone for storefront demos.',
    category: 'Demo Smartphones',
    brand: 'Aster Demo Devices',
  },
] as const;

const variantDefinitions = [
  {
    product: 'Demo NovaBook Air',
    sku: 'DEMO-NBA-8-256',
    name: '8 GB / 256 GB / Silver',
    price: 15990000,
    stock: 12,
    attributes: { ram: '8GB', storage: '256GB', color: 'silver' },
    position: 0,
  },
  {
    product: 'Demo NovaBook Air',
    sku: 'DEMO-NBA-16-512',
    name: '16 GB / 512 GB / Midnight',
    price: 18990000,
    stock: 8,
    attributes: { ram: '16GB', storage: '512GB', color: 'midnight' },
    position: 1,
  },
  {
    product: 'Demo NovaBook Pro',
    sku: 'DEMO-NBP-16-512',
    name: '16 GB / 512 GB / Graphite',
    price: 21990000,
    stock: 6,
    attributes: { ram: '16GB', storage: '512GB', color: 'graphite' },
    position: 0,
  },
  {
    product: 'Demo NovaBook Pro',
    sku: 'DEMO-NBP-32-1TB',
    name: '32 GB / 1 TB / Graphite',
    price: 24990000,
    stock: 0,
    attributes: { ram: '32GB', storage: '1TB', color: 'graphite' },
    position: 1,
  },
  {
    product: 'Demo Aster Phone X',
    sku: 'DEMO-APX-128',
    name: '128 GB / Aurora Blue',
    price: 12990000,
    stock: 20,
    attributes: { storage: '128GB', color: 'aurora-blue' },
    position: 0,
  },
  {
    product: 'Demo Aster Phone X',
    sku: 'DEMO-APX-256',
    name: '256 GB / Aurora Blue',
    price: 14990000,
    stock: 14,
    attributes: { storage: '256GB', color: 'aurora-blue' },
    position: 1,
  },
  {
    product: 'Demo Aster Phone X',
    sku: 'DEMO-APX-512',
    name: '512 GB / Eclipse Black',
    price: 16990000,
    stock: 5,
    attributes: { storage: '512GB', color: 'eclipse-black' },
    position: 2,
  },
] as const;

export interface DemoSeedSummary {
  users: number;
  categories: number;
  brands: number;
  products: number;
  variants: number;
  addresses: number;
  cartItems: number;
  wishlistItems: number;
  orders: number;
  reviews: number;
  payments: number;
}

export async function seedDemoData(
  dataSource: DataSource,
  options: {
    target: DemoSeedTarget;
    nodeEnvironment?: string;
    productionApproval?: {
      confirmation?: string;
      database?: string;
    };
  },
): Promise<DemoSeedSummary> {
  assertSafeDemoSeedDatabase(
    dataSource,
    options.target,
    options.nodeEnvironment,
    options.productionApproval,
  );
  if (!dataSource.isInitialized) {
    throw new Error('Demo seed DataSource must be initialized');
  }

  return dataSource.transaction(async (manager) => {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
    const isProduction = options.target === 'production';
    const customer = isProduction
      ? await upsertProductionCustomer(manager, passwordHash)
      : await upsertUser(
          manager,
          DEMO_CUSTOMER_EMAIL,
          passwordHash,
          UserRole.USER,
        );
    if (!isProduction) {
      await upsertUser(manager, DEMO_ADMIN_EMAIL, passwordHash, UserRole.ADMIN);
    }

    const categories = new Map<string, Category>();
    for (const definition of categoryDefinitions) {
      const category = await upsertCategory(manager, definition);
      categories.set(definition.name, category);
    }

    const brands = new Map<string, Brand>();
    for (const definition of brandDefinitions) {
      const brand = await upsertBrand(manager, definition);
      brands.set(definition.name, brand);
    }

    const products = new Map<string, Product>();
    for (const definition of productDefinitions) {
      const product = await upsertProduct(
        manager,
        definition,
        requireMapped(categories, definition.category),
        requireMapped(brands, definition.brand),
      );
      products.set(definition.name, product);
    }

    const variants = new Map<string, ProductVariant>();
    for (const definition of variantDefinitions) {
      const variant = await upsertVariant(
        manager,
        definition,
        requireMapped(products, definition.product),
      );
      variants.set(definition.sku, variant);
    }

    const address = await upsertAddress(manager, customer.id);
    const cart = await upsertCart(manager, customer.id);
    await upsertCartItem(
      manager,
      cart.id,
      requireMapped(variants, 'DEMO-NBP-16-512').id,
      1,
    );
    await upsertCartItem(
      manager,
      cart.id,
      requireMapped(variants, 'DEMO-APX-128').id,
      2,
    );

    await manager.getRepository(WishlistItem).upsert(
      {
        userId: customer.id,
        productId: requireMapped(products, 'Demo NovaBook Air').id,
      },
      ['userId', 'productId'],
    );

    const deliveredVariant = requireMapped(variants, 'DEMO-NBA-8-256');
    const deliveredOrder = await upsertDeliveredOrder(
      manager,
      customer.id,
      address,
      deliveredVariant,
    );
    await manager.getRepository(ProductReview).upsert(
      {
        userId: customer.id,
        productId: deliveredVariant.productId,
        rating: 5,
        title: 'Great demo product',
        body: 'A fictional review backed by the delivered demo Order.',
        isVisible: true,
      },
      ['userId', 'productId'],
    );

    if (deliveredOrder.status !== OrderStatus.DELIVERED) {
      throw new Error('Demo delivered Order invariant was not established');
    }

    return {
      users: isProduction ? 1 : 2,
      categories: categoryDefinitions.length,
      brands: brandDefinitions.length,
      products: productDefinitions.length,
      variants: variantDefinitions.length,
      addresses: 1,
      cartItems: 2,
      wishlistItems: 1,
      orders: 1,
      reviews: 1,
      payments: 0,
    };
  });
}

async function upsertProductionCustomer(
  manager: EntityManager,
  password: string,
): Promise<User> {
  const repository = manager.getRepository(User);
  const existing = await repository.findOne({
    where: { email: DEMO_CUSTOMER_EMAIL },
    lock: { mode: 'pessimistic_write' },
  });
  if (existing && existing.role !== UserRole.USER) {
    throw new Error(
      'Production demo seed refuses to modify an existing privileged account',
    );
  }
  return upsertUser(manager, DEMO_CUSTOMER_EMAIL, password, UserRole.USER);
}

async function upsertUser(
  manager: EntityManager,
  email: string,
  password: string,
  role: UserRole,
): Promise<User> {
  await manager
    .getRepository(User)
    .upsert({ email, password, role }, ['email']);
  return manager.getRepository(User).findOneByOrFail({ email });
}

async function upsertCategory(
  manager: EntityManager,
  definition: (typeof categoryDefinitions)[number],
): Promise<Category> {
  const slug = createSlug(definition.name);
  await manager
    .getRepository(Category)
    .upsert({ ...definition, slug }, ['slug']);
  return manager.getRepository(Category).findOneByOrFail({ slug });
}

async function upsertBrand(
  manager: EntityManager,
  definition: (typeof brandDefinitions)[number],
): Promise<Brand> {
  const slug = createSlug(definition.name);
  await manager.getRepository(Brand).upsert({ ...definition, slug }, ['slug']);
  return manager.getRepository(Brand).findOneByOrFail({ slug });
}

async function upsertProduct(
  manager: EntityManager,
  definition: (typeof productDefinitions)[number],
  category: Category,
  brand: Brand,
): Promise<Product> {
  const slug = createSlug(definition.name);
  await manager.getRepository(Product).upsert(
    {
      name: definition.name,
      slug,
      description: definition.description,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: brand.id,
    },
    ['slug'],
  );
  return manager.getRepository(Product).findOneByOrFail({ slug });
}

async function upsertVariant(
  manager: EntityManager,
  definition: (typeof variantDefinitions)[number],
  product: Product,
): Promise<ProductVariant> {
  await manager.getRepository(ProductVariant).upsert(
    {
      productId: product.id,
      sku: definition.sku,
      name: definition.name,
      price: definition.price,
      stock: definition.stock,
      attributes: { ...definition.attributes },
      isActive: true,
      position: definition.position,
    },
    ['sku'],
  );
  return manager
    .getRepository(ProductVariant)
    .findOneByOrFail({ sku: definition.sku });
}

async function upsertAddress(
  manager: EntityManager,
  userId: number,
): Promise<Address> {
  const repository = manager.getRepository(Address);
  const existing = await repository.findOneBy({
    userId,
    label: DEMO_ADDRESS_LABEL,
  });
  return repository.save(
    repository.create({
      ...(existing ?? {}),
      userId,
      label: DEMO_ADDRESS_LABEL,
      recipientName: 'Demo Customer',
      phone: '+84900000000',
      addressLine1: '100 Demo Avenue',
      addressLine2: DEMO_ORDER_MARKER,
      ward: 'Demo Ward',
      district: 'Demo District',
      city: 'Ho Chi Minh City',
      stateProvince: null,
      postalCode: '700000',
      countryCode: 'VN',
      isDefault: false,
    }),
  );
}

async function upsertCart(
  manager: EntityManager,
  userId: number,
): Promise<Cart> {
  await manager.getRepository(Cart).upsert({ userId }, ['userId']);
  return manager.getRepository(Cart).findOneByOrFail({ userId });
}

async function upsertCartItem(
  manager: EntityManager,
  cartId: number,
  variantId: number,
  quantity: number,
): Promise<void> {
  await manager
    .getRepository(CartItem)
    .upsert({ cartId, variantId, quantity }, ['cartId', 'variantId']);
}

async function upsertDeliveredOrder(
  manager: EntityManager,
  userId: number,
  address: Address,
  variant: ProductVariant,
): Promise<Order> {
  const repository = manager.getRepository(Order);
  let order = await repository
    .createQueryBuilder('demo_order')
    .where('demo_order.userId = :userId', { userId })
    .andWhere(`demo_order."shippingAddress" ->> 'addressLine2' = :marker`, {
      marker: DEMO_ORDER_MARKER,
    })
    .getOne();

  order = await repository.save(
    repository.create({
      ...(order ?? {}),
      userId,
      totalPrice: variant.price,
      status: OrderStatus.DELIVERED,
      shippingAddress: snapshotShippingAddress(address),
    }),
  );

  const orderItems = manager.getRepository(OrderItem);
  await orderItems.delete({ orderId: order.id });
  await orderItems.save(
    orderItems.create({
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      price: variant.price,
    }),
  );
  return order;
}

function requireMapped<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (!value) throw new Error(`Missing deterministic demo reference: ${key}`);
  return value;
}
