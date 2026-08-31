import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Address } from '../addresses/entities/address.entity';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { ProductStatus } from '../products/entities/product-status.enum';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { Product } from '../products/entities/product.entity';
import { TelegramService } from '../telegram/telegram.service';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatus } from './entities/order-status.enum';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';

describe('OrdersService lifecycle', () => {
  const addressRepo = { findOneBy: jest.fn() };
  const variantRepo = { findOne: jest.fn(), save: jest.fn() };
  const productRepo = { findOneBy: jest.fn() };
  const orderRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
  };
  const orderItemRepo = {
    create: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
  };
  const paymentRepo = { find: jest.fn(), save: jest.fn() };
  const manager = {
    getRepository: jest.fn((entity) => repository(entity)),
  };
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => unknown) =>
      work(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn((entity) => repository(entity)),
  };
  const telegram = { sendMessage: jest.fn() };
  let service: OrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    addressRepo.findOneBy.mockResolvedValue(address());
    variantRepo.findOne.mockResolvedValue(variant());
    variantRepo.save.mockImplementation(async (value) => value);
    productRepo.findOneBy.mockResolvedValue(product());
    orderItemRepo.create.mockImplementation((value) => value);
    orderItemRepo.find.mockResolvedValue([]);
    orderItemRepo.save.mockImplementation(async (value) => value);
    orderRepo.create.mockImplementation((value) => value);
    orderRepo.save.mockImplementation(async (value) => ({ id: 1, ...value }));
    orderRepo.find.mockResolvedValue([]);
    orderRepo.findOneBy.mockResolvedValue(order());
    paymentRepo.find.mockResolvedValue([]);
    paymentRepo.save.mockImplementation(async (value) => value);
    telegram.sendMessage.mockResolvedValue(undefined);
    const promotionsService = {
      findAndValidate: jest.fn(),
      calculatePricing: jest.fn((subtotal: number) => ({
        subtotal,
        discount: 0,
        total: subtotal,
        appliedCoupon: null,
      })),
    };
    service = new OrdersService(
      dataSource as unknown as DataSource,
      telegram as unknown as TelegramService,
      promotionsService as unknown as any,
    );
  });

  it('requires an Address owned by the checkout user', async () => {
    addressRepo.findOneBy.mockResolvedValue(null);
    await expect(
      service.checkout(7, {
        addressId: 12,
        items: [{ variantId: 1, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(addressRepo.findOneBy).toHaveBeenCalledWith({ id: 12, userId: 7 });
    expect(variantRepo.findOne).not.toHaveBeenCalled();
  });

  it('copies an immutable Address snapshot during checkout', async () => {
    const selectedAddress = address();
    addressRepo.findOneBy.mockResolvedValue(selectedAddress);
    await service.checkout(7, {
      addressId: selectedAddress.id,
      items: [{ variantId: 1, quantity: 1 }],
    });
    const created = orderRepo.create.mock.calls[0][0];
    expect(created.shippingAddress).toEqual({
      recipientName: 'Recipient',
      phone: '+12025550123',
      addressLine1: 'Address line',
      addressLine2: null,
      ward: null,
      district: null,
      city: 'City',
      stateProvince: null,
      postalCode: null,
      countryCode: 'US',
    });
    selectedAddress.recipientName = 'Changed later';
    expect(created.shippingAddress.recipientName).toBe('Recipient');
  });

  it('uses explicit VND semantics in the Order notification', async () => {
    await service.checkout(7, {
      addressId: 12,
      items: [{ variantId: 1, quantity: 1 }],
    });

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('100000 VND'),
    );
    expect(telegram.sendMessage.mock.calls[0][0]).not.toContain('$');
  });

  it('returns a plain serializable Order view after checkout', async () => {
    const result = await service.checkout(7, {
      addressId: 12,
      items: [{ variantId: 1, quantity: 1 }],
    });

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result).toEqual(
      expect.objectContaining({
        id: 1,
        userId: 7,
        status: OrderStatus.PENDING,
        totalPrice: 100_000,
      }),
    );
    expect(result.items[0]).not.toHaveProperty('order');
    expect(result.items[0].variant.product).toEqual(
      expect.objectContaining({ id: 10, name: 'Product', slug: 'product' }),
    );
  });

  it('aggregates duplicates and locks unique Variant IDs in ascending order', async () => {
    variantRepo.findOne.mockImplementation(async ({ where }) =>
      variant({ id: where.id, stock: 5 }),
    );
    await service.checkout(7, {
      addressId: 12,
      items: [
        { variantId: 5, quantity: 1 },
        { variantId: 2, quantity: 1 },
        { variantId: 5, quantity: 2 },
      ],
    });
    expect(
      variantRepo.findOne.mock.calls.map(([value]) => value.where.id),
    ).toEqual([2, 5]);
    expect(orderItemRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: 5, quantity: 3 }),
    );
  });

  it('returns only an owned Order and hides wrong ownership as 404', async () => {
    orderRepo.findOne.mockResolvedValue(order());
    await expect(service.findOneForUser(7, 3)).resolves.toEqual(
      expect.objectContaining({ id: 3, userId: 7 }),
    );
    expect(orderRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3, userId: 7 } }),
    );
    orderRepo.findOne.mockResolvedValue(null);
    await expect(service.findOneForUser(8, 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows only the next forward transition without touching stock', async () => {
    const selected = order({ status: OrderStatus.PENDING });
    orderRepo.findOne.mockResolvedValue(selected);
    await expect(
      service.updateStatus(selected.id, OrderStatus.CONFIRMED),
    ).resolves.toEqual(
      expect.objectContaining({ status: OrderStatus.CONFIRMED }),
    );
    expect(variantRepo.save).not.toHaveBeenCalled();
    await expect(
      service.updateStatus(selected.id, OrderStatus.SHIPPED),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels transactionally, aggregates quantities and locks Variants ascending', async () => {
    const selected = order({ status: OrderStatus.PENDING });
    orderRepo.findOne.mockResolvedValue(selected);
    orderItemRepo.find.mockResolvedValue([
      { id: 1, orderId: 3, variantId: 5, quantity: 1 },
      { id: 2, orderId: 3, variantId: 2, quantity: 2 },
      { id: 3, orderId: 3, variantId: 5, quantity: 3 },
    ]);
    const variants = new Map([
      [2, variant({ id: 2, stock: 4 })],
      [5, variant({ id: 5, stock: 1 })],
    ]);
    variantRepo.findOne.mockImplementation(async ({ where }) =>
      variants.get(where.id),
    );
    await service.cancelForUser(7, 3);
    expect(
      variantRepo.findOne.mock.calls.map(([value]) => value.where.id),
    ).toEqual([2, 5]);
    expect(variants.get(2)?.stock).toBe(6);
    expect(variants.get(5)?.stock).toBe(5);
    expect(selected.status).toBe(OrderStatus.CANCELLED);
  });

  it('cannot double-cancel or cancel after shipment, so stock is not restored twice', async () => {
    const selected = order({ status: OrderStatus.PENDING });
    orderRepo.findOne.mockResolvedValue(selected);
    orderItemRepo.find.mockResolvedValue([
      { id: 1, orderId: 3, variantId: 2, quantity: 2 },
    ]);
    const selectedVariant = variant({ id: 2, stock: 3 });
    variantRepo.findOne.mockResolvedValue(selectedVariant);
    await service.cancelForUser(7, 3);
    await expect(service.cancelForUser(7, 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(selectedVariant.stock).toBe(5);
    expect(variantRepo.save).toHaveBeenCalledTimes(1);

    orderRepo.findOne.mockResolvedValue(order({ status: OrderStatus.SHIPPED }));
    await expect(service.cancelForUser(7, 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(variantRepo.save).toHaveBeenCalledTimes(1);
  });

  it('rejects cancellation of a paid Order without restoring stock', async () => {
    orderRepo.findOne.mockResolvedValue(order());
    paymentRepo.find.mockResolvedValue([
      { id: 9, status: PaymentStatus.SUCCEEDED },
    ]);

    await expect(service.cancelForUser(7, 3)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(orderItemRepo.find).not.toHaveBeenCalled();
    expect(variantRepo.save).not.toHaveBeenCalled();
  });

  it('cancels unfinished Payment attempts with an unpaid Order', async () => {
    const pending = { id: 9, status: PaymentStatus.PENDING };
    const processing = { id: 10, status: PaymentStatus.PROCESSING };
    orderRepo.findOne.mockResolvedValue(order());
    paymentRepo.find.mockResolvedValue([pending, processing]);

    await service.cancelForUser(7, 3);

    expect(paymentRepo.save).toHaveBeenCalledWith([pending, processing]);
    expect(pending.status).toBe(PaymentStatus.CANCELLED);
    expect(processing.status).toBe(PaymentStatus.CANCELLED);
  });

  function repository(entity: unknown) {
    if (entity === Address) return addressRepo;
    if (entity === ProductVariant) return variantRepo;
    if (entity === Product) return productRepo;
    if (entity === Order) return orderRepo;
    if (entity === OrderItem) return orderItemRepo;
    if (entity === Payment) return paymentRepo;
  }
});

function address(): Address {
  return {
    id: 12,
    userId: 7,
    user: { id: 7 } as Address['user'],
    label: null,
    recipientName: 'Recipient',
    phone: '+12025550123',
    addressLine1: 'Address line',
    addressLine2: null,
    ward: null,
    district: null,
    city: 'City',
    stateProvince: null,
    postalCode: null,
    countryCode: 'US',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 3,
    userId: 7,
    user: { id: 7 } as Order['user'],
    subtotalPrice: 100_000,
    discountPrice: 0,
    totalPrice: 100_000,
    couponCode: null,
    couponType: null,
    couponValue: null,
    status: OrderStatus.PENDING,
    shippingAddress: {
      recipientName: 'Recipient',
      phone: '+12025550123',
      addressLine1: 'Address line',
      addressLine2: null,
      ward: null,
      district: null,
      city: 'City',
      stateProvince: null,
      postalCode: null,
      countryCode: 'US',
    },
    items: [orderItem()],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function orderItem(): OrderItem {
  return {
    id: 1,
    orderId: 3,
    order: { id: 3 } as Order,
    variantId: 1,
    variant: variant(),
    quantity: 1,
    price: 100_000,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 10,
    name: 'Product',
    slug: 'product',
    description: null,
    status: ProductStatus.ACTIVE,
    categoryId: 1,
    category: { id: 1 } as Product['category'],
    brandId: null,
    brand: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: 1,
    productId: 10,
    product: product(),
    sku: 'SKU-1',
    name: 'Default',
    price: 100_000,
    compareAtPrice: null,
    stock: 5,
    attributes: {},
    isActive: true,
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
