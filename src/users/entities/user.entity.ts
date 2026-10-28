import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  OneToMany,
  OneToOne,
} from 'typeorm';
import { Address } from '../../addresses/entities/address.entity';
import { ProductReview } from '../../reviews/entities/product-review.entity';
import { WishlistItem } from '../../wishlist/entities/wishlist-item.entity';
import { UserRole } from './user-role.enum';
import { Cart } from '../../carts/entities/cart.entity';

@Entity('users') // The database table is named "users"
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', unique: true }) // Emails must be unique
  email!: string;

  @Column({ type: 'varchar', select: false }) // Password (stored hashed)
  password!: string;

  @Column({ type: 'varchar', default: UserRole.USER }) // New accounts are regular users
  role!: UserRole;

  @OneToOne(() => Cart, (cart) => cart.user)
  cart?: Cart;

  @OneToMany(() => Address, (address) => address.user)
  addresses?: Address[];

  @OneToMany(() => WishlistItem, (item) => item.user)
  wishlistItems?: WishlistItem[];

  @OneToMany(() => ProductReview, (review) => review.user)
  productReviews?: ProductReview[];

  @CreateDateColumn()
  createdAt!: Date;
}
