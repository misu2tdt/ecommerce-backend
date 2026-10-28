import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { AuthModule } from '../auth/auth.module';
import { getOrderPaymentWindowMinutes } from '../config/environment';
import { PromotionsModule } from '../promotions/promotions.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrderExpiryScheduler } from './order-expiry.scheduler';
import { OrderExpiryService } from './order-expiry.service';
import { ORDER_PAYMENT_WINDOW_MINUTES } from './orders.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Product]),
    AuthModule,
    PromotionsModule,
  ],
  controllers: [OrdersController, AdminOrdersController],
  providers: [
    OrdersService,
    OrderExpiryService,
    OrderExpiryScheduler,
    {
      provide: ORDER_PAYMENT_WINDOW_MINUTES,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        getOrderPaymentWindowMinutes((key) => configService.get(key)),
    },
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
