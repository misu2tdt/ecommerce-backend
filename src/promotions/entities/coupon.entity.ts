import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  VND_MAX_AMOUNT,
  nullableVndMoneyTransformer,
  vndMoneyTransformer,
} from '../../money/vnd-money';
import { CouponType } from './coupon-type.enum';

@Entity('coupons')
@Index('UQ_coupons_code', ['code'], { unique: true })
@Check('CHK_coupons_type', `"type" IN ('PERCENTAGE', 'FIXED')`)
@Check(
  'CHK_coupons_value',
  `"value" > 0 AND "value" <= ${VND_MAX_AMOUNT} AND ("type" <> 'PERCENTAGE' OR "value" <= 100)`,
)
@Check(
  'CHK_coupons_min_subtotal',
  `"minSubtotal" IS NULL OR ("minSubtotal" >= 0 AND "minSubtotal" <= ${VND_MAX_AMOUNT})`,
)
@Check(
  'CHK_coupons_max_discount',
  `"maxDiscount" IS NULL OR ("maxDiscount" > 0 AND "maxDiscount" <= ${VND_MAX_AMOUNT} AND "type" = 'PERCENTAGE')`,
)
@Check(
  'CHK_coupons_date_range',
  `"startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt"`,
)
export class Coupon {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: CouponType;

  @Column({ type: 'bigint', transformer: vndMoneyTransformer })
  value!: number;

  @Column({
    type: 'bigint',
    transformer: nullableVndMoneyTransformer,
    nullable: true,
  })
  minSubtotal!: number | null;

  @Column({
    type: 'bigint',
    transformer: nullableVndMoneyTransformer,
    nullable: true,
  })
  maxDiscount!: number | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  startsAt!: Date | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  endsAt!: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
