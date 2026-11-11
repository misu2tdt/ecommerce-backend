import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AdminCollectionsController } from './admin-collections.controller';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionProduct } from './entities/collection-product.entity';
import { Collection } from './entities/collection.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Collection, CollectionProduct]),
    AuthModule,
  ],
  controllers: [CollectionsController, AdminCollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
