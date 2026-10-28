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
import { Order } from '../../orders/entities/order.entity';
import { VND_MAX_AMOUNT, vndMoneyTransformer } from '../../money/vnd-money';
import { PaymentEvent } from './payment-event.entity';
import { PaymentStatus } from './payment-status.enum';

// An Order may have at most one active Payment. FAILED and CANCELLED payments
// do not count, so a customer can retry after a failure.
export const ACTIVE_PAYMENT_INDEX = 'UQ_payments_one_active_per_order';

@Entity('payments')
@Index('UQ_payments_idempotency_key', ['idempotencyKey'], { unique: true })
@Index(ACTIVE_PAYMENT_INDEX, ['orderId'], {
  unique: true,
  where: `"status" IN ('pending', 'processing', 'succeeded')`,
})
@Index('UQ_payments_provider_payment', ['provider', 'providerPaymentId'], {
  unique: true,
  where: '"providerPaymentId" IS NOT NULL',
})
@Index('IDX_payments_order_status', ['orderId', 'status'])
@Check('CHK_payments_amount', `"amount" >= 0 AND "amount" <= ${VND_MAX_AMOUNT}`)
@Check(
  'CHK_payments_status',
  `"status" IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')`,
)
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  orderId!: number;

  @ManyToOne(() => Order, (order) => order.payments, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'orderId',
    foreignKeyConstraintName: 'FK_payments_order',
  })
  order!: Order;

  @Column({ type: 'varchar', length: 50 })
  provider!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerPaymentId!: string | null;

  @Column({ type: 'varchar', length: 128 })
  idempotencyKey!: string;

  @Column({ type: 'bigint', transformer: vndMoneyTransformer })
  amount!: number;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  failureCode!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureMessage!: string | null;

  @OneToMany(() => PaymentEvent, (event) => event.payment)
  events?: PaymentEvent[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  succeededAt!: Date | null;
}
