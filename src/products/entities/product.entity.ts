import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Brand } from '../../brands/entities/brand.entity';
import { Category } from '../../categories/entities/category.entity';
import { ProductImage } from './product-image.entity';
import { ProductStatus } from './product-status.enum';
import { ProductVariant } from './product-variant.entity';
import { WishlistItem } from '../../wishlist/entities/wishlist-item.entity';
import { ProductReview } from '../../reviews/entities/product-review.entity';

// The trigram GIN index of the name search (see the migration
// AddProductNameTrigramIndex). TypeORM can not describe an operator class, so the
// declaration only tells it the index exists and must be left alone:
// synchronize: false.
@Entity('products')
@Index('IDX_products_name_trgm', { synchronize: false })
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: 'varchar' })
  name!: string;
  @Column({ type: 'varchar', unique: true })
  slug!: string;
  @Column({ type: 'text', nullable: true })
  description!: string | null;
  @Column({ type: 'varchar', default: ProductStatus.ACTIVE })
  status!: ProductStatus;
  @Column({ type: 'int' })
  categoryId!: number;
  @ManyToOne(() => Category, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'categoryId' })
  category!: Category;
  @Column({ type: 'int', nullable: true })
  brandId!: number | null;
  @ManyToOne(() => Brand, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'brandId' })
  brand!: Brand | null;
  @OneToMany(() => ProductImage, (image) => image.product)
  images?: ProductImage[];
  @OneToMany(() => ProductVariant, (variant) => variant.product)
  variants?: ProductVariant[];
  @OneToMany(() => WishlistItem, (item) => item.product)
  wishlistItems?: WishlistItem[];
  @OneToMany(() => ProductReview, (review) => review.product)
  reviews?: ProductReview[];
  @CreateDateColumn()
  createdAt!: Date;
  @UpdateDateColumn()
  updatedAt!: Date;
}
