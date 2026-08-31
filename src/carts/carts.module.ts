import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { CartItem } from './entities/cart-item.entity';
import { Cart } from './entities/cart.entity';
import { CartsController } from './carts.controller';
import { CartsService } from './carts.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cart, CartItem]),
    AuthModule,
    OrdersModule,
    PromotionsModule,
  ],
  controllers: [CartsController],
  providers: [CartsService],
})
export class CartsModule {}
