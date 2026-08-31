import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  VND_MAX_AMOUNT,
  nullableVndMoneyTransformer,
  vndMoneyTransformer,
} from '../../money/vnd-money';
import type { ShippingAddressSnapshot } from '../shipping-address';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status.enum';
import { Payment } from '../../payments/entities/payment.entity';

@Entity('orders')
@Check(
  'CHK_orders_status',
  `"status" IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled')`,
)
@Check(
  'CHK_orders_subtotal_price',
  `"subtotalPrice" >= 0 AND "subtotalPrice" <= ${VND_MAX_AMOUNT}`,
)
@Check(
  'CHK_orders_discount_price',
  `"discountPrice" >= 0 AND "discountPrice" <= "subtotalPrice"`,
)
@Check(
  'CHK_orders_total_price',
  `"totalPrice" >= 0 AND "totalPrice" <= ${VND_MAX_AMOUNT}`,
)
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'bigint', transformer: vndMoneyTransformer, default: 0 })
  subtotalPrice!: number;

  @Column({ type: 'bigint', transformer: vndMoneyTransformer, default: 0 })
  discountPrice!: number;

  @Column({ type: 'bigint', transformer: vndMoneyTransformer })
  totalPrice!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  couponCode!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  couponType!: string | null;

  @Column({
    type: 'bigint',
    transformer: nullableVndMoneyTransformer,
    nullable: true,
  })
  couponValue!: number | null;

  @Column({ type: 'varchar', default: OrderStatus.PENDING })
  status!: OrderStatus;

  @Column({ type: 'jsonb' })
  shippingAddress!: ShippingAddressSnapshot;

  @Column({ type: 'int' })
  userId!: number;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @OneToMany(() => OrderItem, (orderItem) => orderItem.order, { cascade: true })
  items!: OrderItem[];

  @OneToMany(() => Payment, (payment) => payment.order)
  payments?: Payment[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
