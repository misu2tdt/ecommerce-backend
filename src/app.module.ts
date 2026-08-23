import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BrandsModule } from './brands/brands.module';
import { CategoriesModule } from './categories/categories.module';
import { validateRuntimeEnvironment } from './config/environment';
import { createDatabaseOptions } from './database/database-options';
import { databaseEntities } from './database/entities';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';
import { TelegramModule } from './telegram/telegram.module';
import { UsersModule } from './users/users.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { ReviewsModule } from './reviews/reviews.module';
import { AddressesModule } from './addresses/addresses.module';
import { CartsModule } from './carts/carts.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (environment) => {
        validateRuntimeEnvironment(environment);
        return environment;
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        ...createDatabaseOptions((key) => configService.get(key)),
        entities: databaseEntities,
        synchronize: false,
      }),
    }),
    UsersModule,
    ProductsModule,
    OrdersModule,
    TelegramModule,
    AuthModule,
    CategoriesModule,
    BrandsModule,
    CartsModule,
    AddressesModule,
    WishlistModule,
    ReviewsModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
