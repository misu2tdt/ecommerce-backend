import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  PaymentEventProcessingStatus,
  PaymentEventType,
} from './payment-event-type.enum';
import { User } from '../../users/entities/user.entity';
import { Payment } from './payment.entity';

@Entity('payment_events')
@Index('UQ_payment_events_provider_event', ['provider', 'providerEventId'], {
  unique: true,
})
@Index('IDX_payment_events_unresolved_reconciliation', ['createdAt', 'id'], {
  where: `"processingStatus" = 'requires_reconciliation' AND "resolvedAt" IS NULL`,
})
@Check(
  'CHK_payment_events_resolution',
  `"resolvedAt" IS NOT NULL OR ("resolvedByUserId" IS NULL AND "resolutionNote" IS NULL)`,
)
@Check('CHK_payment_events_type', `"eventType" IN ('succeeded', 'failed')`)
@Check(
  'CHK_payment_events_processing_status',
  `"processingStatus" IN ('processed', 'requires_reconciliation')`,
)
export class PaymentEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  paymentId!: number;

  @ManyToOne(() => Payment, (payment) => payment.events, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'paymentId',
    foreignKeyConstraintName: 'FK_payment_events_payment',
  })
  payment!: Payment;

  @Column({ type: 'varchar', length: 50 })
  provider!: string;

  @Column({ type: 'varchar', length: 255 })
  providerEventId!: string;

  @Column({ type: 'varchar', length: 255 })
  providerPaymentId!: string;

  @Column({ type: 'varchar' })
  eventType!: PaymentEventType;

  @Column({
    type: 'varchar',
    default: PaymentEventProcessingStatus.PROCESSED,
  })
  processingStatus!: PaymentEventProcessingStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  processingMessage!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  processedAt!: Date | null;

  // Set when an admin records that a requires_reconciliation event was handled.
  @Column({ type: 'timestamp', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  resolvedByUserId!: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'resolvedByUserId',
    foreignKeyConstraintName: 'FK_payment_events_resolved_by',
  })
  resolvedBy?: User | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  resolutionNote!: string | null;
}
