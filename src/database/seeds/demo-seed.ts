import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, In } from 'typeorm';
import { Address } from '../../addresses/entities/address.entity';
import { Brand } from '../../brands/entities/brand.entity';
import { CartItem } from '../../carts/entities/cart-item.entity';
import { Cart } from '../../carts/entities/cart.entity';
import { createSlug } from '../../catalog/slug';
import { Category } from '../../categories/entities/category.entity';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { OrderStatus } from '../../orders/entities/order-status.enum';
import { Order } from '../../orders/entities/order.entity';
import { snapshotShippingAddress } from '../../orders/shipping-address';
import { ProductStatus } from '../../products/entities/product-status.enum';
import { ProductVariant } from '../../products/entities/product-variant.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductReview } from '../../reviews/entities/product-review.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import { User } from '../../users/entities/user.entity';
import { WishlistItem } from '../../wishlist/entities/wishlist-item.entity';
import { CouponType } from '../../promotions/entities/coupon-type.enum';
import { Coupon } from '../../promotions/entities/coupon.entity';
import { assertSafeDemoSeedDatabase, DemoSeedTarget } from './demo-seed-safety';

export const DEMO_CUSTOMER_EMAIL = 'demo.customer@example.com';
export const DEMO_ADMIN_EMAIL = 'demo.admin@example.com';
export const DEMO_PASSWORD = 'DemoOnly!2026';

export const DEMO_ADDRESS_LABEL = 'Phase 6A Demo Address';
export const DEMO_ORDER_MARKER = 'Phase 6A Fashion Demo Suite';

export const LEGACY_DEMO_ORDER_MARKER = 'Phase 3B Demo Suite';
export const LEGACY_DEMO_ADDRESS_LABEL = 'Phase 3B Demo Address';

export const LEGACY_CATEGORY_SLUGS = ['demo-laptops', 'demo-smartphones'];
export const LEGACY_BRAND_SLUGS = [
  'nova-demo-technologies',
  'aster-demo-devices',
];
export const LEGACY_PRODUCT_SLUGS = [
  'demo-novabook-air',
  'demo-novabook-pro',
  'demo-aster-phone-x',
];
export const LEGACY_VARIANT_SKUS = [
  'DEMO-NBA-8-256',
  'DEMO-NBA-16-512',
  'DEMO-NBP-16-512',
  'DEMO-NBP-32-1TB',
  'DEMO-APX-128',
  'DEMO-APX-256',
  'DEMO-APX-512',
];

const BCRYPT_ROUNDS = 10;

const categoryDefinitions = [
  {
    name: 'T-Shirts & Tops',
    description:
      'Everyday crewnecks, heavyweight tees, waffle knits, and active shirts.',
  },
  {
    name: 'Shirts & Polos',
    description:
      'Pique cotton polos, breathable tech polos, and casual button-down shirts.',
  },
  {
    name: 'Hoodies & Outerwear',
    description:
      'French terry zip hoodies, fleece pullovers, and lightweight windbreakers.',
  },
  {
    name: 'Pants & Shorts',
    description:
      'Everyday chinos, stretch jogger pants, utility cargo pants, and active shorts.',
  },
  {
    name: 'Basics & Accessories',
    description:
      'Premium bamboo boxers, modal briefs, cotton crew socks, and daily accessories.',
  },
] as const;

const brandDefinitions = [
  {
    name: 'AeroThread',
    description:
      'A fictional apparel label specializing in modern everyday essentials and minimalist casualwear.',
  },
  {
    name: 'Kanso Basics',
    description:
      'A fictional brand dedicated to premium comfort essentials, loungewear, and underwear.',
  },
  {
    name: 'Veloce Active',
    description:
      'A fictional performance brand creating technical activewear and outdoor apparel.',
  },
  {
    name: 'Monolith Studio',
    description:
      'A fictional contemporary brand focusing on structured tailoring and outerwear.',
  },
] as const;

const productDefinitions = [
  // T-Shirts & Tops
  {
    name: 'Classic Crewneck Cotton Tee',
    description:
      'Crafted from 100% combed ring-spun cotton for an ultra-soft feel and everyday durability.',
    category: 'T-Shirts & Tops',
    brand: 'AeroThread',
  },
  {
    name: 'Heavyweight Boxy Pocket Tee',
    description:
      'Substantial 240 GSM cotton knit with a relaxed boxy cut and reinforced chest pocket.',
    category: 'T-Shirts & Tops',
    brand: 'AeroThread',
  },
  {
    name: 'Seamless Performance Training Tee',
    description:
      'Engineered knit with body-mapped breathability zones and anti-odor moisture management.',
    category: 'T-Shirts & Tops',
    brand: 'Veloce Active',
  },
  {
    name: 'Waffle Knit Long Sleeve Tee',
    description:
      'Textured thermal cotton blend offering lightweight warmth and easy layering.',
    category: 'T-Shirts & Tops',
    brand: 'Kanso Basics',
  },
  {
    name: 'Supima Modal Oversized Tee',
    description:
      'Silky Supima cotton and modal blend with a relaxed streetwear drape.',
    category: 'T-Shirts & Tops',
    brand: 'Kanso Basics',
  },
  {
    name: 'Breathable Mesh Running Singlet',
    description:
      'Ultra-lightweight mesh tank designed for high-heat runs and maximum airflow.',
    category: 'T-Shirts & Tops',
    brand: 'Veloce Active',
  },

  // Shirts & Polos
  {
    name: 'Classic Pique Cotton Polo',
    description:
      'Timeless double-knit pique polo with mother-of-pearl buttons and a stay-flat collar.',
    category: 'Shirts & Polos',
    brand: 'AeroThread',
  },
  {
    name: 'Tech Knit Zipper Polo',
    description:
      'Modern performance polo featuring a matte quarter-zip collar and 4-way stretch fabric.',
    category: 'Shirts & Polos',
    brand: 'Veloce Active',
  },
  {
    name: 'Relaxed Oxford Button-Down Shirt',
    description:
      'Garment-washed cotton Oxford cloth offering effortless smart-casual versatility.',
    category: 'Shirts & Polos',
    brand: 'AeroThread',
  },
  {
    name: 'Linen Short-Sleeve Resort Shirt',
    description:
      'Airy French flax linen with a camp collar cut for warm-weather ease.',
    category: 'Shirts & Polos',
    brand: 'Monolith Studio',
  },
  {
    name: 'Structured Workwear Overshirt',
    description:
      'Durable heavyweight twill with dual patch pockets, built to wear over tees or knitwear.',
    category: 'Shirts & Polos',
    brand: 'Monolith Studio',
  },

  // Hoodies & Outerwear
  {
    name: 'French Terry Full-Zip Hoodie',
    description:
      'Premium 380 GSM loopback French terry with double-lined hood and two-way metal zipper.',
    category: 'Hoodies & Outerwear',
    brand: 'AeroThread',
  },
  {
    name: 'Heavyweight Pullover Sweatshirt',
    description:
      'Clean minimalist crewneck sweatshirt with ribbed side gussets and brushed interior.',
    category: 'Hoodies & Outerwear',
    brand: 'Kanso Basics',
  },
  {
    name: 'Packable Trail Windbreaker',
    description:
      'DWR-treated ripstop shell that packs into its own pocket with reflective accents.',
    category: 'Hoodies & Outerwear',
    brand: 'Veloce Active',
  },
  {
    name: 'Minimalist Technical Bomber Jacket',
    description:
      'Sleek water-resistant shell jacket with ribbed storm collar and ergonomic sleeve design.',
    category: 'Hoodies & Outerwear',
    brand: 'Monolith Studio',
  },
  {
    name: 'Water-Resistant Commuter Parka',
    description:
      'Extended weather protection featuring sealed critical seams and an adjustable hood.',
    category: 'Hoodies & Outerwear',
    brand: 'Monolith Studio',
  },

  // Pants & Shorts
  {
    name: 'Everyday Stretch Chino Pants',
    description:
      'Tailored slim-straight fit made with breathable cotton twill and subtle elastane stretch.',
    category: 'Pants & Shorts',
    brand: 'AeroThread',
  },
  {
    name: 'Comfort Drawstring Jogger Pants',
    description:
      'Tapered lounge pants with an elastic waistband, metal-tipped drawcord, and deep zip pockets.',
    category: 'Pants & Shorts',
    brand: 'Kanso Basics',
  },
  {
    name: 'Active Training 7-Inch Shorts',
    description:
      'Quick-drying stretch shorts with built-in compression liner and hidden phone pocket.',
    category: 'Pants & Shorts',
    brand: 'Veloce Active',
  },
  {
    name: 'Ripstop Utility Cargo Shorts',
    description:
      'Rugged yet lightweight cargo shorts equipped with low-profile snap pockets.',
    category: 'Pants & Shorts',
    brand: 'Monolith Studio',
  },
  {
    name: 'Tailored Pleated Easy Trousers',
    description:
      'Single-pleat wide-tapered trousers with elasticated back waist for all-day comfort.',
    category: 'Pants & Shorts',
    brand: 'Monolith Studio',
  },

  // Basics & Accessories
  {
    name: 'Bamboo Fiber Boxer Briefs 3-Pack',
    description:
      'Naturally antibacterial bamboo viscose boxer briefs with a non-rolling elastic band.',
    category: 'Basics & Accessories',
    brand: 'Kanso Basics',
  },
  {
    name: 'Seamless Modal Trunks 2-Pack',
    description:
      'Ultra-soft Lenzing Modal trunks with flatlock seams for second-skin comfort.',
    category: 'Basics & Accessories',
    brand: 'Kanso Basics',
  },
  {
    name: 'Cushioned Cotton Crew Socks 3-Pack',
    description:
      'Arch-supporting daily crew socks with reinforced heel and toe cushioning.',
    category: 'Basics & Accessories',
    brand: 'AeroThread',
  },
  {
    name: 'Heavy Canvas Daily Tote Bag',
    description:
      'Sturdy 16 oz organic cotton canvas tote with interior divider and key clip.',
    category: 'Basics & Accessories',
    brand: 'AeroThread',
  },
  {
    name: 'Lightweight Ripstop Running Cap',
    description:
      'UPF 50+ unstructured performance cap with laser-cut ventilation and webbing strap.',
    category: 'Basics & Accessories',
    brand: 'Veloce Active',
  },
] as const;

const variantDefinitions = [
  // 1. Classic Crewneck Cotton Tee (199,000 VND)
  {
    product: 'Classic Crewneck Cotton Tee',
    sku: 'AT-CCT-BLK-M',
    name: 'Black / M',
    price: 199000,
    compareAtPrice: 249000,
    stock: 25,
    attributes: { size: 'M', color: 'Black' },
    position: 0,
  },
  {
    product: 'Classic Crewneck Cotton Tee',
    sku: 'AT-CCT-BLK-L',
    name: 'Black / L',
    price: 199000,
    compareAtPrice: 249000,
    stock: 20,
    attributes: { size: 'L', color: 'Black' },
    position: 1,
  },
  {
    product: 'Classic Crewneck Cotton Tee',
    sku: 'AT-CCT-WHT-M',
    name: 'White / M',
    price: 199000,
    compareAtPrice: 249000,
    stock: 15,
    attributes: { size: 'M', color: 'White' },
    position: 2,
  },

  // 2. Heavyweight Boxy Pocket Tee (259,000 VND)
  {
    product: 'Heavyweight Boxy Pocket Tee',
    sku: 'AT-HBT-OAT-M',
    name: 'Oatmeal / M',
    price: 259000,
    compareAtPrice: 329000,
    stock: 18,
    attributes: { size: 'M', color: 'Oatmeal' },
    position: 0,
  },
  {
    product: 'Heavyweight Boxy Pocket Tee',
    sku: 'AT-HBT-OAT-L',
    name: 'Oatmeal / L',
    price: 259000,
    compareAtPrice: 329000,
    stock: 12,
    attributes: { size: 'L', color: 'Oatmeal' },
    position: 1,
  },
  {
    product: 'Heavyweight Boxy Pocket Tee',
    sku: 'AT-HBT-SGE-L',
    name: 'Sage Green / L',
    price: 259000,
    compareAtPrice: 329000,
    stock: 10,
    attributes: { size: 'L', color: 'Sage Green' },
    position: 2,
  },

  // 3. Seamless Performance Training Tee (289,000 VND)
  {
    product: 'Seamless Performance Training Tee',
    sku: 'VA-SPT-CHR-M',
    name: 'Charcoal / M',
    price: 289000,
    stock: 30,
    attributes: { size: 'M', color: 'Charcoal' },
    position: 0,
  },
  {
    product: 'Seamless Performance Training Tee',
    sku: 'VA-SPT-CHR-L',
    name: 'Charcoal / L',
    price: 289000,
    stock: 22,
    attributes: { size: 'L', color: 'Charcoal' },
    position: 1,
  },
  {
    product: 'Seamless Performance Training Tee',
    sku: 'VA-SPT-NVY-XL',
    name: 'Navy / XL',
    price: 289000,
    stock: 0,
    attributes: { size: 'XL', color: 'Navy' },
    position: 2,
  },

  // 4. Waffle Knit Long Sleeve Tee (329,000 VND)
  {
    product: 'Waffle Knit Long Sleeve Tee',
    sku: 'KB-WLT-SND-M',
    name: 'Sand / M',
    price: 329000,
    stock: 14,
    attributes: { size: 'M', color: 'Sand' },
    position: 0,
  },
  {
    product: 'Waffle Knit Long Sleeve Tee',
    sku: 'KB-WLT-SND-L',
    name: 'Sand / L',
    price: 329000,
    stock: 16,
    attributes: { size: 'L', color: 'Sand' },
    position: 1,
  },
  {
    product: 'Waffle Knit Long Sleeve Tee',
    sku: 'KB-WLT-BLK-L',
    name: 'Black / L',
    price: 329000,
    stock: 8,
    attributes: { size: 'L', color: 'Black' },
    position: 2,
  },

  // 5. Supima Modal Oversized Tee (279,000 VND)
  {
    product: 'Supima Modal Oversized Tee',
    sku: 'KB-SMT-IVO-S',
    name: 'Ivory / S',
    price: 279000,
    stock: 12,
    attributes: { size: 'S', color: 'Ivory' },
    position: 0,
  },
  {
    product: 'Supima Modal Oversized Tee',
    sku: 'KB-SMT-IVO-M',
    name: 'Ivory / M',
    price: 279000,
    stock: 18,
    attributes: { size: 'M', color: 'Ivory' },
    position: 1,
  },
  {
    product: 'Supima Modal Oversized Tee',
    sku: 'KB-SMT-CLD-L',
    name: 'Cloud Grey / L',
    price: 279000,
    stock: 15,
    attributes: { size: 'L', color: 'Cloud Grey' },
    position: 2,
  },

  // 6. Breathable Mesh Running Singlet (229,000 VND)
  {
    product: 'Breathable Mesh Running Singlet',
    sku: 'VA-BMS-COR-M',
    name: 'Coral Red / M',
    price: 229000,
    stock: 10,
    attributes: { size: 'M', color: 'Coral Red' },
    position: 0,
  },
  {
    product: 'Breathable Mesh Running Singlet',
    sku: 'VA-BMS-COR-L',
    name: 'Coral Red / L',
    price: 229000,
    stock: 14,
    attributes: { size: 'L', color: 'Coral Red' },
    position: 1,
  },
  {
    product: 'Breathable Mesh Running Singlet',
    sku: 'VA-BMS-BLK-L',
    name: 'Black / L',
    price: 229000,
    stock: 20,
    attributes: { size: 'L', color: 'Black' },
    position: 2,
  },

  // 7. Classic Pique Cotton Polo (349,000 VND)
  {
    product: 'Classic Pique Cotton Polo',
    sku: 'AT-PCP-NVY-M',
    name: 'Navy Blue / M',
    price: 349000,
    stock: 24,
    attributes: { size: 'M', color: 'Navy Blue' },
    position: 0,
  },
  {
    product: 'Classic Pique Cotton Polo',
    sku: 'AT-PCP-NVY-L',
    name: 'Navy Blue / L',
    price: 349000,
    stock: 18,
    attributes: { size: 'L', color: 'Navy Blue' },
    position: 1,
  },
  {
    product: 'Classic Pique Cotton Polo',
    sku: 'AT-PCP-WHT-L',
    name: 'White / L',
    price: 349000,
    stock: 16,
    attributes: { size: 'L', color: 'White' },
    position: 2,
  },

  // 8. Tech Knit Zipper Polo (389,000 VND)
  {
    product: 'Tech Knit Zipper Polo',
    sku: 'VA-TZP-OLV-M',
    name: 'Olive Green / M',
    price: 389000,
    stock: 15,
    attributes: { size: 'M', color: 'Olive Green' },
    position: 0,
  },
  {
    product: 'Tech Knit Zipper Polo',
    sku: 'VA-TZP-OLV-L',
    name: 'Olive Green / L',
    price: 389000,
    stock: 12,
    attributes: { size: 'L', color: 'Olive Green' },
    position: 1,
  },
  {
    product: 'Tech Knit Zipper Polo',
    sku: 'VA-TZP-BLK-XL',
    name: 'Black / XL',
    price: 389000,
    stock: 9,
    attributes: { size: 'XL', color: 'Black' },
    position: 2,
  },

  // 9. Relaxed Oxford Button-Down Shirt (429,000 VND)
  {
    product: 'Relaxed Oxford Button-Down Shirt',
    sku: 'AT-ROB-LBL-M',
    name: 'Light Blue / M',
    price: 429000,
    stock: 16,
    attributes: { size: 'M', color: 'Light Blue' },
    position: 0,
  },
  {
    product: 'Relaxed Oxford Button-Down Shirt',
    sku: 'AT-ROB-LBL-L',
    name: 'Light Blue / L',
    price: 429000,
    stock: 20,
    attributes: { size: 'L', color: 'Light Blue' },
    position: 1,
  },
  {
    product: 'Relaxed Oxford Button-Down Shirt',
    sku: 'AT-ROB-WHT-L',
    name: 'White / L',
    price: 429000,
    stock: 14,
    attributes: { size: 'L', color: 'White' },
    position: 2,
  },

  // 10. Linen Short-Sleeve Resort Shirt (459,000 VND)
  {
    product: 'Linen Short-Sleeve Resort Shirt',
    sku: 'MS-LRS-BEI-M',
    name: 'Beige / M',
    price: 459000,
    stock: 11,
    attributes: { size: 'M', color: 'Beige' },
    position: 0,
  },
  {
    product: 'Linen Short-Sleeve Resort Shirt',
    sku: 'MS-LRS-BEI-L',
    name: 'Beige / L',
    price: 459000,
    stock: 14,
    attributes: { size: 'L', color: 'Beige' },
    position: 1,
  },
  {
    product: 'Linen Short-Sleeve Resort Shirt',
    sku: 'MS-LRS-TER-L',
    name: 'Terracotta / L',
    price: 459000,
    stock: 0,
    attributes: { size: 'L', color: 'Terracotta' },
    position: 2,
  },

  // 11. Structured Workwear Overshirt (549,000 VND)
  {
    product: 'Structured Workwear Overshirt',
    sku: 'MS-SWO-KHK-M',
    name: 'Khaki / M',
    price: 549000,
    stock: 10,
    attributes: { size: 'M', color: 'Khaki' },
    position: 0,
  },
  {
    product: 'Structured Workwear Overshirt',
    sku: 'MS-SWO-KHK-L',
    name: 'Khaki / L',
    price: 549000,
    stock: 12,
    attributes: { size: 'L', color: 'Khaki' },
    position: 1,
  },
  {
    product: 'Structured Workwear Overshirt',
    sku: 'MS-SWO-BLK-L',
    name: 'Washed Black / L',
    price: 549000,
    stock: 10,
    attributes: { size: 'L', color: 'Washed Black' },
    position: 2,
  },

  // 12. French Terry Full-Zip Hoodie (529,000 VND)
  {
    product: 'French Terry Full-Zip Hoodie',
    sku: 'AT-FZH-HGR-M',
    name: 'Heather Grey / M',
    price: 529000,
    stock: 20,
    attributes: { size: 'M', color: 'Heather Grey' },
    position: 0,
  },
  {
    product: 'French Terry Full-Zip Hoodie',
    sku: 'AT-FZH-HGR-L',
    name: 'Heather Grey / L',
    price: 529000,
    stock: 15,
    attributes: { size: 'L', color: 'Heather Grey' },
    position: 1,
  },
  {
    product: 'French Terry Full-Zip Hoodie',
    sku: 'AT-FZH-BLK-L',
    name: 'Black / L',
    price: 529000,
    stock: 18,
    attributes: { size: 'L', color: 'Black' },
    position: 2,
  },

  // 13. Heavyweight Pullover Sweatshirt (489,000 VND)
  {
    product: 'Heavyweight Pullover Sweatshirt',
    sku: 'KB-HPS-FOR-M',
    name: 'Forest Green / M',
    price: 489000,
    stock: 14,
    attributes: { size: 'M', color: 'Forest Green' },
    position: 0,
  },
  {
    product: 'Heavyweight Pullover Sweatshirt',
    sku: 'KB-HPS-FOR-L',
    name: 'Forest Green / L',
    price: 489000,
    stock: 16,
    attributes: { size: 'L', color: 'Forest Green' },
    position: 1,
  },
  {
    product: 'Heavyweight Pullover Sweatshirt',
    sku: 'KB-HPS-BLK-XL',
    name: 'Black / XL',
    price: 489000,
    stock: 10,
    attributes: { size: 'XL', color: 'Black' },
    position: 2,
  },

  // 14. Packable Trail Windbreaker (599,000 VND)
  {
    product: 'Packable Trail Windbreaker',
    sku: 'VA-PTW-CYN-M',
    name: 'Cyan Blue / M',
    price: 599000,
    stock: 12,
    attributes: { size: 'M', color: 'Cyan Blue' },
    position: 0,
  },
  {
    product: 'Packable Trail Windbreaker',
    sku: 'VA-PTW-CYN-L',
    name: 'Cyan Blue / L',
    price: 599000,
    stock: 15,
    attributes: { size: 'L', color: 'Cyan Blue' },
    position: 1,
  },
  {
    product: 'Packable Trail Windbreaker',
    sku: 'VA-PTW-BLK-L',
    name: 'Black / L',
    price: 599000,
    stock: 8,
    attributes: { size: 'L', color: 'Black' },
    position: 2,
  },

  // 15. Minimalist Technical Bomber Jacket (689,000 VND)
  {
    product: 'Minimalist Technical Bomber Jacket',
    sku: 'MS-MTB-DGR-M',
    name: 'Dark Grey / M',
    price: 689000,
    stock: 9,
    attributes: { size: 'M', color: 'Dark Grey' },
    position: 0,
  },
  {
    product: 'Minimalist Technical Bomber Jacket',
    sku: 'MS-MTB-DGR-L',
    name: 'Dark Grey / L',
    price: 689000,
    stock: 11,
    attributes: { size: 'L', color: 'Dark Grey' },
    position: 1,
  },
  {
    product: 'Minimalist Technical Bomber Jacket',
    sku: 'MS-MTB-BLK-L',
    name: 'Black / L',
    price: 689000,
    stock: 0,
    attributes: { size: 'L', color: 'Black' },
    position: 2,
  },

  // 16. Water-Resistant Commuter Parka (789,000 VND)
  {
    product: 'Water-Resistant Commuter Parka',
    sku: 'MS-WCP-OLV-M',
    name: 'Olive / M',
    price: 789000,
    stock: 7,
    attributes: { size: 'M', color: 'Olive' },
    position: 0,
  },
  {
    product: 'Water-Resistant Commuter Parka',
    sku: 'MS-WCP-OLV-L',
    name: 'Olive / L',
    price: 789000,
    stock: 9,
    attributes: { size: 'L', color: 'Olive' },
    position: 1,
  },

  // 17. Everyday Stretch Chino Pants (469,000 VND)
  {
    product: 'Everyday Stretch Chino Pants',
    sku: 'AT-ESC-KHK-30',
    name: 'Khaki / 30',
    price: 469000,
    stock: 16,
    attributes: { size: '30', color: 'Khaki' },
    position: 0,
  },
  {
    product: 'Everyday Stretch Chino Pants',
    sku: 'AT-ESC-KHK-32',
    name: 'Khaki / 32',
    price: 469000,
    stock: 22,
    attributes: { size: '32', color: 'Khaki' },
    position: 1,
  },
  {
    product: 'Everyday Stretch Chino Pants',
    sku: 'AT-ESC-NVY-32',
    name: 'Navy / 32',
    price: 469000,
    stock: 18,
    attributes: { size: '32', color: 'Navy' },
    position: 2,
  },

  // 18. Comfort Drawstring Jogger Pants (399,000 VND)
  {
    product: 'Comfort Drawstring Jogger Pants',
    sku: 'KB-CDJ-GRY-M',
    name: 'Grey / M',
    price: 399000,
    stock: 20,
    attributes: { size: 'M', color: 'Grey' },
    position: 0,
  },
  {
    product: 'Comfort Drawstring Jogger Pants',
    sku: 'KB-CDJ-GRY-L',
    name: 'Grey / L',
    price: 399000,
    stock: 25,
    attributes: { size: 'L', color: 'Grey' },
    position: 1,
  },
  {
    product: 'Comfort Drawstring Jogger Pants',
    sku: 'KB-CDJ-BLK-L',
    name: 'Black / L',
    price: 399000,
    stock: 19,
    attributes: { size: 'L', color: 'Black' },
    position: 2,
  },

  // 19. Active Training 7-Inch Shorts (299,000 VND)
  {
    product: 'Active Training 7-Inch Shorts',
    sku: 'VA-ATS-BLK-M',
    name: 'Black / M',
    price: 299000,
    stock: 28,
    attributes: { size: 'M', color: 'Black' },
    position: 0,
  },
  {
    product: 'Active Training 7-Inch Shorts',
    sku: 'VA-ATS-BLK-L',
    name: 'Black / L',
    price: 299000,
    stock: 24,
    attributes: { size: 'L', color: 'Black' },
    position: 1,
  },
  {
    product: 'Active Training 7-Inch Shorts',
    sku: 'VA-ATS-NVY-L',
    name: 'Navy / L',
    price: 299000,
    stock: 15,
    attributes: { size: 'L', color: 'Navy' },
    position: 2,
  },

  // 20. Ripstop Utility Cargo Shorts (369,000 VND)
  {
    product: 'Ripstop Utility Cargo Shorts',
    sku: 'MS-RCS-SND-M',
    name: 'Sand / M',
    price: 369000,
    stock: 14,
    attributes: { size: 'M', color: 'Sand' },
    position: 0,
  },
  {
    product: 'Ripstop Utility Cargo Shorts',
    sku: 'MS-RCS-SND-L',
    name: 'Sand / L',
    price: 369000,
    stock: 17,
    attributes: { size: 'L', color: 'Sand' },
    position: 1,
  },
  {
    product: 'Ripstop Utility Cargo Shorts',
    sku: 'MS-RCS-OLV-L',
    name: 'Olive / L',
    price: 369000,
    stock: 12,
    attributes: { size: 'L', color: 'Olive' },
    position: 2,
  },

  // 21. Tailored Pleated Easy Trousers (569,000 VND)
  {
    product: 'Tailored Pleated Easy Trousers',
    sku: 'MS-TET-CHR-30',
    name: 'Charcoal / 30',
    price: 569000,
    stock: 10,
    attributes: { size: '30', color: 'Charcoal' },
    position: 0,
  },
  {
    product: 'Tailored Pleated Easy Trousers',
    sku: 'MS-TET-CHR-32',
    name: 'Charcoal / 32',
    price: 569000,
    stock: 13,
    attributes: { size: '32', color: 'Charcoal' },
    position: 1,
  },

  // 22. Bamboo Fiber Boxer Briefs 3-Pack (249,000 VND)
  {
    product: 'Bamboo Fiber Boxer Briefs 3-Pack',
    sku: 'KB-BBB-AST-M',
    name: 'Assorted Colors / M',
    price: 249000,
    stock: 35,
    attributes: { size: 'M', color: 'Assorted' },
    position: 0,
  },
  {
    product: 'Bamboo Fiber Boxer Briefs 3-Pack',
    sku: 'KB-BBB-AST-L',
    name: 'Assorted Colors / L',
    price: 249000,
    stock: 40,
    attributes: { size: 'L', color: 'Assorted' },
    position: 1,
  },
  {
    product: 'Bamboo Fiber Boxer Briefs 3-Pack',
    sku: 'KB-BBB-AST-XL',
    name: 'Assorted Colors / XL',
    price: 249000,
    stock: 25,
    attributes: { size: 'XL', color: 'Assorted' },
    position: 2,
  },

  // 23. Seamless Modal Trunks 2-Pack (199,000 VND)
  {
    product: 'Seamless Modal Trunks 2-Pack',
    sku: 'KB-SMT-BLK-M',
    name: 'Black & Grey / M',
    price: 199000,
    stock: 30,
    attributes: { size: 'M', color: 'Black & Grey' },
    position: 0,
  },
  {
    product: 'Seamless Modal Trunks 2-Pack',
    sku: 'KB-SMT-BLK-L',
    name: 'Black & Grey / L',
    price: 199000,
    stock: 28,
    attributes: { size: 'L', color: 'Black & Grey' },
    position: 1,
  },

  // 24. Cushioned Cotton Crew Socks 3-Pack (129,000 VND)
  {
    product: 'Cushioned Cotton Crew Socks 3-Pack',
    sku: 'AT-CCS-WHT-OS',
    name: 'White / One Size',
    price: 129000,
    stock: 50,
    attributes: { size: 'One Size', color: 'White' },
    position: 0,
  },
  {
    product: 'Cushioned Cotton Crew Socks 3-Pack',
    sku: 'AT-CCS-BLK-OS',
    name: 'Black / One Size',
    price: 129000,
    stock: 45,
    attributes: { size: 'One Size', color: 'Black' },
    position: 1,
  },

  // 25. Heavy Canvas Daily Tote Bag (219,000 VND)
  {
    product: 'Heavy Canvas Daily Tote Bag',
    sku: 'AT-CDT-NAT-OS',
    name: 'Natural Ecru',
    price: 219000,
    stock: 25,
    attributes: { color: 'Natural Ecru' },
    position: 0,
  },
  {
    product: 'Heavy Canvas Daily Tote Bag',
    sku: 'AT-CDT-BLK-OS',
    name: 'Washed Black',
    price: 219000,
    stock: 20,
    attributes: { color: 'Washed Black' },
    position: 1,
  },

  // 26. Lightweight Ripstop Running Cap (179,000 VND)
  {
    product: 'Lightweight Ripstop Running Cap',
    sku: 'VA-RRC-BLK-OS',
    name: 'Reflective Black',
    price: 179000,
    stock: 30,
    attributes: { color: 'Reflective Black' },
    position: 0,
  },
  {
    product: 'Lightweight Ripstop Running Cap',
    sku: 'VA-RRC-SLV-OS',
    name: 'Reflective Silver',
    price: 179000,
    stock: 0,
    attributes: { color: 'Reflective Silver' },
    position: 1,
  },
] as const;

export interface DemoSeedSummary {
  users: number;
  categories: number;
  brands: number;
  products: number;
  variants: number;
  coupons: number;
  addresses: number;
  cartItems: number;
  wishlistItems: number;
  orders: number;
  reviews: number;
  payments: number;
}

export async function seedDemoData(
  dataSource: DataSource,
  options: {
    target: DemoSeedTarget;
    nodeEnvironment?: string;
    productionApproval?: {
      confirmation?: string;
      database?: string;
    };
  },
): Promise<DemoSeedSummary> {
  assertSafeDemoSeedDatabase(
    dataSource,
    options.target,
    options.nodeEnvironment,
    options.productionApproval,
  );
  if (!dataSource.isInitialized) {
    throw new Error('Demo seed DataSource must be initialized');
  }

  return dataSource.transaction(async (manager) => {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
    const isProduction = options.target === 'production';
    const customer = isProduction
      ? await upsertProductionCustomer(manager, passwordHash)
      : await upsertUser(
          manager,
          DEMO_CUSTOMER_EMAIL,
          passwordHash,
          UserRole.USER,
        );
    if (!isProduction) {
      await upsertUser(manager, DEMO_ADMIN_EMAIL, passwordHash, UserRole.ADMIN);
    }

    // 1. Retire legacy demo catalog products and variants if present
    await manager
      .getRepository(ProductVariant)
      .createQueryBuilder()
      .update(ProductVariant)
      .set({ isActive: false })
      .where('sku IN (:...skus)', { skus: LEGACY_VARIANT_SKUS })
      .execute();

    await manager
      .getRepository(Product)
      .createQueryBuilder()
      .update(Product)
      .set({ status: ProductStatus.INACTIVE })
      .where('slug IN (:...slugs)', { slugs: LEGACY_PRODUCT_SLUGS })
      .execute();

    const categories = new Map<string, Category>();
    for (const definition of categoryDefinitions) {
      const category = await upsertCategory(manager, definition);
      categories.set(definition.name, category);
    }

    const brands = new Map<string, Brand>();
    for (const definition of brandDefinitions) {
      const brand = await upsertBrand(manager, definition);
      brands.set(definition.name, brand);
    }

    const products = new Map<string, Product>();
    for (const definition of productDefinitions) {
      const product = await upsertProduct(
        manager,
        definition,
        requireMapped(categories, definition.category),
        requireMapped(brands, definition.brand),
      );
      products.set(definition.name, product);
    }

    const variants = new Map<string, ProductVariant>();
    for (const definition of variantDefinitions) {
      const variant = await upsertVariant(
        manager,
        definition,
        requireMapped(products, definition.product),
      );
      variants.set(definition.sku, variant);
    }

    const address = await upsertAddress(manager, customer.id);
    const cart = await upsertCart(manager, customer.id);

    // 2. Clean up legacy demo cart items owned by demo customer
    const legacyVariants = await manager
      .getRepository(ProductVariant)
      .find({ where: { sku: In(LEGACY_VARIANT_SKUS) } });
    if (legacyVariants.length > 0) {
      await manager
        .getRepository(CartItem)
        .createQueryBuilder()
        .delete()
        .from(CartItem)
        .where('cartId = :cartId AND variantId IN (:...variantIds)', {
          cartId: cart.id,
          variantIds: legacyVariants.map((v) => v.id),
        })
        .execute();
    }

    // 3. Clean up legacy demo wishlist items owned by demo customer
    const legacyProducts = await manager
      .getRepository(Product)
      .find({ where: { slug: In(LEGACY_PRODUCT_SLUGS) } });
    if (legacyProducts.length > 0) {
      await manager
        .getRepository(WishlistItem)
        .createQueryBuilder()
        .delete()
        .from(WishlistItem)
        .where('userId = :userId AND productId IN (:...productIds)', {
          userId: customer.id,
          productIds: legacyProducts.map((p) => p.id),
        })
        .execute();
    }

    // 4. Upsert Phase 6A fashion cart items
    await upsertCartItem(
      manager,
      cart.id,
      requireMapped(variants, 'AT-PCP-NVY-M').id,
      1,
    );
    await upsertCartItem(
      manager,
      cart.id,
      requireMapped(variants, 'KB-CDJ-GRY-M').id,
      2,
    );

    // 5. Upsert Phase 6A fashion wishlist item
    await manager.getRepository(WishlistItem).upsert(
      {
        userId: customer.id,
        productId: requireMapped(products, 'Classic Crewneck Cotton Tee').id,
      },
      ['userId', 'productId'],
    );

    // 6. Upsert Phase 6A delivered order (without touching legacy order or deleting items)
    const deliveredVariant = requireMapped(variants, 'AT-CCT-BLK-M');
    const deliveredOrder = await upsertDeliveredOrder(
      manager,
      customer.id,
      address,
      deliveredVariant,
      DEMO_ORDER_MARKER,
    );

    // 7. Upsert Phase 6A fashion review
    await manager.getRepository(ProductReview).upsert(
      {
        userId: customer.id,
        productId: deliveredVariant.productId,
        rating: 5,
        title: 'Essential daily tee',
        body: 'Extremely comfortable breathable fabric and great fit after washing.',
        isVisible: true,
      },
      ['userId', 'productId'],
    );

    if (deliveredOrder.status !== OrderStatus.DELIVERED) {
      throw new Error('Demo delivered Order invariant was not established');
    }

    // 8. Upsert Phase 6E promotional coupons
    const couponsCount = await upsertDemoCoupons(manager);

    return {
      users: isProduction ? 1 : 2,
      categories: categoryDefinitions.length,
      brands: brandDefinitions.length,
      products: productDefinitions.length,
      variants: variantDefinitions.length,
      coupons: couponsCount,
      addresses: 1,
      cartItems: 2,
      wishlistItems: 1,
      orders: 1,
      reviews: 1,
      payments: 0,
    };
  });
}

async function upsertProductionCustomer(
  manager: EntityManager,
  password: string,
): Promise<User> {
  const repository = manager.getRepository(User);
  const existing = await repository.findOne({
    where: { email: DEMO_CUSTOMER_EMAIL },
    lock: { mode: 'pessimistic_write' },
  });
  if (existing && existing.role !== UserRole.USER) {
    throw new Error(
      'Production demo seed refuses to modify an existing privileged account',
    );
  }
  return upsertUser(manager, DEMO_CUSTOMER_EMAIL, password, UserRole.USER);
}

async function upsertUser(
  manager: EntityManager,
  email: string,
  password: string,
  role: UserRole,
): Promise<User> {
  await manager
    .getRepository(User)
    .upsert({ email, password, role }, ['email']);
  return manager.getRepository(User).findOneByOrFail({ email });
}

async function upsertCategory(
  manager: EntityManager,
  definition: (typeof categoryDefinitions)[number],
): Promise<Category> {
  const slug = createSlug(definition.name);
  await manager
    .getRepository(Category)
    .upsert({ ...definition, slug }, ['slug']);
  return manager.getRepository(Category).findOneByOrFail({ slug });
}

async function upsertBrand(
  manager: EntityManager,
  definition: (typeof brandDefinitions)[number],
): Promise<Brand> {
  const slug = createSlug(definition.name);
  await manager.getRepository(Brand).upsert({ ...definition, slug }, ['slug']);
  return manager.getRepository(Brand).findOneByOrFail({ slug });
}

async function upsertProduct(
  manager: EntityManager,
  definition: (typeof productDefinitions)[number],
  category: Category,
  brand: Brand,
): Promise<Product> {
  const slug = createSlug(definition.name);
  await manager.getRepository(Product).upsert(
    {
      name: definition.name,
      slug,
      description: definition.description,
      status: ProductStatus.ACTIVE,
      categoryId: category.id,
      brandId: brand.id,
    },
    ['slug'],
  );
  return manager.getRepository(Product).findOneByOrFail({ slug });
}

async function upsertVariant(
  manager: EntityManager,
  definition: (typeof variantDefinitions)[number],
  product: Product,
): Promise<ProductVariant> {
  await manager.getRepository(ProductVariant).upsert(
    {
      productId: product.id,
      sku: definition.sku,
      name: definition.name,
      price: definition.price,
      compareAtPrice:
        'compareAtPrice' in definition
          ? (definition.compareAtPrice as number)
          : null,
      stock: definition.stock,
      attributes: { ...definition.attributes },
      isActive: true,
      position: definition.position,
    },
    ['sku'],
  );
  return manager
    .getRepository(ProductVariant)
    .findOneByOrFail({ sku: definition.sku });
}

async function upsertDemoCoupons(manager: EntityManager): Promise<number> {
  const coupons = [
    {
      code: 'WELCOME10',
      name: '10% off for orders over 300,000 VND (max 100,000 VND)',
      type: CouponType.PERCENTAGE,
      value: 10,
      minSubtotal: 300000,
      maxDiscount: 100000,
      isActive: true,
    },
    {
      code: 'STYLE50',
      name: '50,000 VND off orders over 500,000 VND',
      type: CouponType.FIXED,
      value: 50000,
      minSubtotal: 500000,
      maxDiscount: null,
      isActive: true,
    },
  ];

  for (const coupon of coupons) {
    await manager.getRepository(Coupon).upsert(
      {
        ...coupon,
        startsAt: null,
        endsAt: null,
      },
      ['code'],
    );
  }
  return coupons.length;
}

async function upsertAddress(
  manager: EntityManager,
  userId: number,
): Promise<Address> {
  const repository = manager.getRepository(Address);
  const existing = await repository.findOneBy({
    userId,
    label: DEMO_ADDRESS_LABEL,
  });
  return repository.save(
    repository.create({
      ...(existing ?? {}),
      userId,
      label: DEMO_ADDRESS_LABEL,
      recipientName: 'Demo Customer',
      phone: '+84900000000',
      addressLine1: '100 Demo Avenue',
      addressLine2: DEMO_ORDER_MARKER,
      ward: 'Demo Ward',
      district: 'Demo District',
      city: 'Ho Chi Minh City',
      stateProvince: null,
      postalCode: '700000',
      countryCode: 'VN',
      isDefault: false,
    }),
  );
}

async function upsertCart(
  manager: EntityManager,
  userId: number,
): Promise<Cart> {
  await manager.getRepository(Cart).upsert({ userId }, ['userId']);
  return manager.getRepository(Cart).findOneByOrFail({ userId });
}

async function upsertCartItem(
  manager: EntityManager,
  cartId: number,
  variantId: number,
  quantity: number,
): Promise<void> {
  await manager
    .getRepository(CartItem)
    .upsert({ cartId, variantId, quantity }, ['cartId', 'variantId']);
}

async function upsertDeliveredOrder(
  manager: EntityManager,
  userId: number,
  address: Address,
  variant: ProductVariant,
  marker: string,
): Promise<Order> {
  const repository = manager.getRepository(Order);
  let order = await repository
    .createQueryBuilder('demo_order')
    .where('demo_order.userId = :userId', { userId })
    .andWhere(`demo_order."shippingAddress" ->> 'addressLine2' = :marker`, {
      marker,
    })
    .getOne();

  if (order) {
    return order;
  }

  order = await repository.save(
    repository.create({
      userId,
      subtotalPrice: variant.price,
      discountPrice: 0,
      totalPrice: variant.price,
      couponCode: null,
      couponType: null,
      couponValue: null,
      status: OrderStatus.DELIVERED,
      shippingAddress: snapshotShippingAddress(address),
    }),
  );

  const orderItems = manager.getRepository(OrderItem);
  await orderItems.save(
    orderItems.create({
      orderId: order.id,
      variantId: variant.id,
      quantity: 1,
      price: variant.price,
    }),
  );

  return order;
}

function requireMapped<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (!value) throw new Error(`Missing deterministic demo reference: ${key}`);
  return value;
}
