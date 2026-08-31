import { Brand } from '../brands/entities/brand.entity';
import { Category } from '../categories/entities/category.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Order } from '../orders/entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { ProductImage } from '../products/entities/product-image.entity';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { User } from '../users/entities/user.entity';
import { Cart } from '../carts/entities/cart.entity';
import { CartItem } from '../carts/entities/cart-item.entity';
import { Address } from '../addresses/entities/address.entity';
import { WishlistItem } from '../wishlist/entities/wishlist-item.entity';
import { ProductReview } from '../reviews/entities/product-review.entity';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentEvent } from '../payments/entities/payment-event.entity';
import { Coupon } from '../promotions/entities/coupon.entity';

export const databaseEntities = [
  User,
  Product,
  Order,
  OrderItem,
  Category,
  Brand,
  ProductImage,
  ProductVariant,
  Cart,
  CartItem,
  Address,
  WishlistItem,
  ProductReview,
  Payment,
  PaymentEvent,
  Coupon,
];
