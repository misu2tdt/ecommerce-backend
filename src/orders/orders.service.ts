import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Address } from '../addresses/entities/address.entity';
import { addVndAmounts, multiplyVndAmount } from '../money/vnd-money';
import { PaymentStatus } from '../payments/entities/payment-status.enum';
import { Payment } from '../payments/entities/payment.entity';
import { ProductStatus } from '../products/entities/product-status.enum';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { Product } from '../products/entities/product.entity';
import { TelegramService } from '../telegram/telegram.service';
import { PromotionsService } from '../promotions/promotions.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatus } from './entities/order-status.enum';
import { Order } from './entities/order.entity';
import { snapshotShippingAddress } from './shipping-address';

interface NormalizedOrderItem {
  variantId: number;
  quantity: number;
}

export interface PreparedCheckout {
  dto: CreateOrderDto;
  afterOrderSaved?: (manager: EntityManager) => Promise<void>;
}

const allowedTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly telegramService: TelegramService,
    private readonly promotionsService: PromotionsService,
  ) {}

  async checkout(userId: number, createOrderDto: CreateOrderDto) {
    return this.checkoutPrepared(userId, () =>
      Promise.resolve({ dto: createOrderDto }),
    );
  }

  async checkoutPrepared(
    userId: number,
    prepare: (manager: EntityManager) => Promise<PreparedCheckout>,
  ) {
    const savedOrder = await this.dataSource.transaction(async (manager) => {
      const prepared = await prepare(manager);
      const address = await manager.getRepository(Address).findOneBy({
        id: prepared.dto.addressId,
        userId,
      });
      if (!address) throw new NotFoundException('Address not found');

      const normalizedItems = this.normalizeItems(prepared.dto);
      const variantRepo = manager.getRepository(ProductVariant);
      const productRepo = manager.getRepository(Product);
      const orderRepo = manager.getRepository(Order);
      const orderItemRepo = manager.getRepository(OrderItem);
      const locked: Array<{ variant: ProductVariant; product: Product }> = [];

      for (const item of normalizedItems) {
        const variant = await variantRepo.findOne({
          where: { id: item.variantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!variant)
          throw new BadRequestException(
            `Variant ID ${item.variantId} does not exist`,
          );
        const product = await productRepo.findOneBy({ id: variant.productId });
        if (!product)
          throw new BadRequestException('Variant Product does not exist');
        locked.push({ variant, product });
      }

      for (const { variant, product } of locked) {
        if (!variant.isActive)
          throw new BadRequestException(`Variant ${variant.name} is inactive`);
        if (product.status === ProductStatus.INACTIVE)
          throw new BadRequestException(`Product ${product.name} is inactive`);
      }
      for (let index = 0; index < normalizedItems.length; index += 1) {
        if (locked[index].variant.stock < normalizedItems[index].quantity) {
          throw new BadRequestException(
            `Variant ${locked[index].variant.name} has insufficient stock`,
          );
        }
      }

      let subtotalPrice = 0;
      for (let index = 0; index < normalizedItems.length; index += 1) {
        const requested = normalizedItems[index];
        const variant = locked[index].variant;
        subtotalPrice = addVndAmounts(
          subtotalPrice,
          multiplyVndAmount(variant.price, requested.quantity),
        );
      }

      let discountPrice = 0;
      let totalPrice = subtotalPrice;
      let couponCode: string | null = null;
      let couponType: string | null = null;
      let couponValue: number | null = null;

      if (prepared.dto.couponCode) {
        const coupon = await this.promotionsService.findAndValidate(
          prepared.dto.couponCode,
          subtotalPrice,
          new Date(),
          manager,
        );
        const pricing = this.promotionsService.calculatePricing(
          subtotalPrice,
          coupon,
        );
        discountPrice = pricing.discount;
        totalPrice = pricing.total;
        couponCode = coupon.code;
        couponType = coupon.type;
        couponValue = coupon.value;
      } else {
        const pricing = this.promotionsService.calculatePricing(
          subtotalPrice,
          null,
        );
        totalPrice = pricing.total;
      }

      const items: OrderItem[] = [];
      for (let index = 0; index < normalizedItems.length; index += 1) {
        const requested = normalizedItems[index];
        const variant = locked[index].variant;
        variant.stock -= requested.quantity;
        await variantRepo.save(variant);
        variant.product = locked[index].product;
        items.push(
          orderItemRepo.create({
            variant,
            variantId: variant.id,
            quantity: requested.quantity,
            price: variant.price,
          }),
        );
      }

      const order = await orderRepo.save(
        orderRepo.create({
          userId,
          subtotalPrice,
          discountPrice,
          totalPrice,
          couponCode,
          couponType,
          couponValue,
          status: OrderStatus.PENDING,
          shippingAddress: snapshotShippingAddress(address),
          items: [],
        }),
      );
      for (const item of items) {
        item.orderId = order.id;
        item.order = order;
      }
      order.items = await orderItemRepo.save(items);
      await prepared.afterOrderSaved?.(manager);
      return order;
    });

    const orderView = this.toOrderView(savedOrder);
    const message = `New order for user ${userId}; total ${orderView.totalPrice} VND; status ${orderView.status}`;
    void this.telegramService
      .sendMessage(message)
      .catch(() => this.logger.error('Unable to send order notification'));
    return orderView;
  }

  async findAllForUser(userId: number) {
    const orders = await this.dataSource.getRepository(Order).find({
      where: { userId },
      relations: { items: { variant: { product: true } } },
      order: { createdAt: 'DESC', id: 'DESC', items: { id: 'ASC' } },
    });
    return orders.map((order) => this.toOrderView(order));
  }

  async findOneForUser(userId: number, id: number) {
    const order = await this.loadOrder({ id, userId });
    if (!order) throw new NotFoundException('Order not found');
    return this.toOrderView(order);
  }

  async findAllForAdmin() {
    const orders = await this.dataSource.getRepository(Order).find({
      relations: { items: { variant: { product: true } } },
      order: { createdAt: 'DESC', id: 'DESC', items: { id: 'ASC' } },
    });
    return orders.map((order) => this.toOrderView(order));
  }

  async findOneForAdmin(id: number) {
    const order = await this.loadOrder({ id });
    if (!order) throw new NotFoundException('Order not found');
    return this.toOrderView(order);
  }

  cancelForUser(userId: number, id: number) {
    return this.cancel(id, userId);
  }

  async updateStatus(id: number, target: OrderStatus) {
    if (target === OrderStatus.CANCELLED) return this.cancel(id);
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Order);
      const order = await repository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Order not found');
      this.assertTransition(order.status, target);
      order.status = target;
      return repository.save(order);
    });
  }

  private async cancel(id: number, userId?: number) {
    return this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(Order);
      const ownedOrder = await orderRepo.findOneBy(
        userId === undefined ? { id } : { id, userId },
      );
      if (!ownedOrder) throw new NotFoundException('Order not found');

      const paymentRepo = manager.getRepository(Payment);
      const payments = await paymentRepo.find({
        where: { orderId: id },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const order = await orderRepo.findOne({
        where: userId === undefined ? { id } : { id, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException('Order not found');
      this.assertTransition(order.status, OrderStatus.CANCELLED);
      if (
        payments.some((payment) => payment.status === PaymentStatus.SUCCEEDED)
      )
        throw new ConflictException(
          'Paid Order cannot be cancelled before refund support',
        );

      const cancellablePayments = payments.filter((payment) =>
        [PaymentStatus.PENDING, PaymentStatus.PROCESSING].includes(
          payment.status,
        ),
      );
      for (const payment of cancellablePayments)
        payment.status = PaymentStatus.CANCELLED;
      if (cancellablePayments.length > 0)
        await paymentRepo.save(cancellablePayments);

      const items = await manager.getRepository(OrderItem).find({
        where: { orderId: order.id },
        order: { variantId: 'ASC', id: 'ASC' },
      });
      const quantities = new Map<number, number>();
      for (const item of items)
        quantities.set(
          item.variantId,
          (quantities.get(item.variantId) ?? 0) + item.quantity,
        );

      const variantRepo = manager.getRepository(ProductVariant);
      for (const [variantId, quantity] of [...quantities.entries()].sort(
        ([first], [second]) => first - second,
      )) {
        const variant = await variantRepo.findOne({
          where: { id: variantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!variant)
          throw new BadRequestException(
            `Variant ID ${variantId} does not exist`,
          );
        variant.stock += quantity;
        await variantRepo.save(variant);
      }

      order.status = OrderStatus.CANCELLED;
      return orderRepo.save(order);
    });
  }

  private assertTransition(current: OrderStatus, target: OrderStatus) {
    if (!allowedTransitions[current].includes(target))
      throw new BadRequestException(
        `Cannot transition Order from ${current} to ${target}`,
      );
  }

  private loadOrder(where: { id: number; userId?: number }) {
    return this.dataSource.getRepository(Order).findOne({
      where,
      relations: { items: { variant: { product: true } } },
      order: { items: { id: 'ASC' } },
    });
  }

  private toOrderView(order: Order) {
    return {
      id: order.id,
      userId: order.userId,
      status: order.status,
      subtotalPrice: order.subtotalPrice,
      discountPrice: order.discountPrice,
      totalPrice: order.totalPrice,
      couponCode: order.couponCode,
      couponType: order.couponType,
      couponValue: order.couponValue,
      shippingAddress: order.shippingAddress,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      items: order.items.map((item) => ({
        id: item.id,
        quantity: item.quantity,
        price: item.price,
        lineTotal: multiplyVndAmount(item.price, item.quantity),
        variant: {
          id: item.variant.id,
          sku: item.variant.sku,
          name: item.variant.name,
          attributes: item.variant.attributes,
          product: {
            id: item.variant.product.id,
            name: item.variant.product.name,
            slug: item.variant.product.slug,
          },
        },
      })),
    };
  }

  private normalizeItems(dto: CreateOrderDto): NormalizedOrderItem[] {
    const quantities = new Map<number, number>();
    for (const item of dto.items)
      quantities.set(
        item.variantId,
        (quantities.get(item.variantId) ?? 0) + item.quantity,
      );
    return [...quantities.entries()]
      .sort(([first], [second]) => first - second)
      .map(([variantId, quantity]) => ({ variantId, quantity }));
  }
}
