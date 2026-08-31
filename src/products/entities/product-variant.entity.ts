import {
  Check,
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
import { OrderItem } from '../../orders/entities/order-item.entity';
import { CartItem } from '../../carts/entities/cart-item.entity';
import {
  VND_MAX_AMOUNT,
  nullableVndMoneyTransformer,
  vndMoneyTransformer,
} from '../../money/vnd-money';
import { Product } from './product.entity';

@Entity('product_variants')
@Index('UQ_product_variants_sku', ['sku'], { unique: true })
@Check(
  'CHK_product_variants_price',
  `"price" >= 0 AND "price" <= ${VND_MAX_AMOUNT}`,
)
@Check(
  'CHK_product_variants_compare_at_price',
  `"compareAtPrice" IS NULL OR ("compareAtPrice" >= 0 AND "compareAtPrice" <= ${VND_MAX_AMOUNT} AND "compareAtPrice" > "price")`,
)
@Check('CHK_product_variants_stock', '"stock" >= 0')
@Check('CHK_product_variants_position', '"position" >= 0')
export class ProductVariant {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  productId!: number;

  @ManyToOne(() => Product, (product) => product.variants, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'productId',
    foreignKeyConstraintName: 'FK_product_variants_product',
  })
  product!: Product;

  @Column({ type: 'varchar', length: 64 })
  sku!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'bigint', transformer: vndMoneyTransformer })
  price!: number;

  @Column({
    type: 'bigint',
    transformer: nullableVndMoneyTransformer,
    nullable: true,
  })
  compareAtPrice!: number | null;

  @Column({ type: 'int', default: 0 })
  stock!: number;

  @Column({ type: 'jsonb', default: {} })
  attributes!: Record<string, string>;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @OneToMany(() => OrderItem, (item) => item.variant)
  orderItems?: OrderItem[];

  @OneToMany(() => CartItem, (item) => item.variant)
  cartItems?: CartItem[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
