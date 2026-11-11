import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { Collection } from './collection.entity';

// One product in one collection, at one place in the collection's order.
// Deleting either side removes the row, never the other side.
@Entity('collection_products')
@Index('IDX_collection_products_product', ['productId'])
@Check('CHK_collection_products_position', `"position" >= 0`)
export class CollectionProduct {
  @PrimaryColumn({ type: 'int' })
  collectionId!: number;

  @PrimaryColumn({ type: 'int' })
  productId!: number;

  // 0-based place in the collection: 0 is shown first.
  @Column({ type: 'int' })
  position!: number;

  @ManyToOne(() => Collection, (collection) => collection.members, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'collectionId' })
  collection?: Collection;

  @ManyToOne(() => Product, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productId' })
  product?: Product;
}
