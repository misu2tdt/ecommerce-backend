import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Brand } from '../brands/entities/brand.entity';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../catalog/database-errors';
import { createSlug } from '../catalog/slug';
import { Category } from '../categories/entities/category.entity';
import { ImageStorageService } from '../image-storage/image-storage.service';
import { parseVndAmount } from '../money/vnd-money';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductStatus } from './entities/product-status.enum';
import { ProductImage } from './entities/product-image.entity';
import { ProductVariant } from './entities/product-variant.entity';
import { Product } from './entities/product.entity';

export type PublicProductImage = Omit<ProductImage, 'storageKey' | 'product'>;
export type PublicProduct = Omit<Product, 'images' | 'variants'> & {
  images: PublicProductImage[];
  minPrice: number | null;
  maxPrice: number | null;
  inStock: boolean;
  averageRating: number | null;
  reviewCount: number;
  variants?: Array<
    Pick<
      ProductVariant,
      'id' | 'sku' | 'name' | 'price' | 'stock' | 'attributes' | 'position'
    >
  >;
};

export type AdminProduct = Omit<Product, 'images' | 'variants'> & {
  images: PublicProductImage[];
  variants: Array<Omit<ProductVariant, 'product' | 'orderItems' | 'cartItems'>>;
  minPrice: number | null;
  maxPrice: number | null;
  inStock: boolean;
};

interface ProductSummaryRaw {
  minPrice: string | null;
  maxPrice: string | null;
  inStock: boolean;
  averageRating: string | null;
  reviewCount: number;
}

type ProductRatingRaw = Pick<
  ProductSummaryRaw,
  'averageRating' | 'reviewCount'
>;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoriesRepository: Repository<Category>,
    @InjectRepository(Brand)
    private readonly brandsRepository: Repository<Brand>,
    @InjectRepository(ProductImage)
    private readonly productImagesRepository: Repository<ProductImage>,
    private readonly imageStorage: ImageStorageService,
  ) {}

  async create(dto: CreateProductDto): Promise<Product> {
    const category = await this.findCategory(dto.categoryId);
    const brand = dto.brandId ? await this.findBrand(dto.brandId) : null;
    const slug = createSlug(dto.name);

    if (await this.productsRepository.existsBy({ slug })) {
      throw new ConflictException('Product slug already exists');
    }

    const product = this.productsRepository.create({
      name: dto.name,
      description: dto.description,
      status: dto.status ?? ProductStatus.ACTIVE,
      slug,
      categoryId: category.id,
      category,
      brandId: brand?.id ?? null,
      brand,
    });

    try {
      return await this.productsRepository.save(product);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Product slug already exists');
      }
      throw error;
    }
  }

  async findAll(query: ProductQueryDto): Promise<PublicProduct[]> {
    const builder = this.productsRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect(
        'product.images',
        'image',
        'image.isPrimary = :isPrimary',
        { isPrimary: true },
      )
      .where('product.status = :status', { status: ProductStatus.ACTIVE });

    builder
      .addSelect(
        '(SELECT MIN(v."price") FROM "product_variants" v WHERE v."productId" = product.id AND v."isActive" = true)',
        'minPrice',
      )
      .addSelect(
        '(SELECT MAX(v."price") FROM "product_variants" v WHERE v."productId" = product.id AND v."isActive" = true)',
        'maxPrice',
      )
      .addSelect(
        'EXISTS(SELECT 1 FROM "product_variants" v WHERE v."productId" = product.id AND v."isActive" = true AND v."stock" > 0)',
        'inStock',
      )
      .addSelect(
        '(SELECT ROUND(AVG(r."rating")::numeric, 2) FROM "product_reviews" r WHERE r."productId" = product.id AND r."isVisible" = true)',
        'averageRating',
      )
      .addSelect(
        '(SELECT COUNT(*)::int FROM "product_reviews" r WHERE r."productId" = product.id AND r."isVisible" = true)',
        'reviewCount',
      );

    if (query.category) {
      builder.andWhere('category.slug = :categorySlug', {
        categorySlug: query.category,
      });
    }
    if (query.brand) {
      builder.andWhere('brand.slug = :brandSlug', { brandSlug: query.brand });
    }
    if (query.q) {
      builder.andWhere('product.name ILIKE :search', {
        search: `%${query.q}%`,
      });
    }

    const { entities, raw } = await builder
      .orderBy('product.name', 'ASC')
      .addOrderBy('product.id', 'ASC')
      .addOrderBy('image.position', 'ASC')
      .addOrderBy('image.id', 'ASC')
      .getRawAndEntities<ProductSummaryRaw>();

    return entities.map((product, index) => {
      const summary = raw[index];
      if (!summary) throw new Error('Product summary row is missing');
      return this.toPublicProduct(product, {
        minPrice:
          summary.minPrice === null ? null : parseVndAmount(summary.minPrice),
        maxPrice:
          summary.maxPrice === null ? null : parseVndAmount(summary.maxPrice),
        inStock: summary.inStock === true,
        averageRating:
          summary.averageRating === null ? null : Number(summary.averageRating),
        reviewCount: Number(summary.reviewCount),
      });
    });
  }

  async findAllForAdmin(): Promise<AdminProduct[]> {
    const products = await this.productsRepository.find({
      relations: { category: true, brand: true, images: true, variants: true },
      order: {
        name: 'ASC',
        id: 'ASC',
        images: { isPrimary: 'DESC', position: 'ASC', id: 'ASC' },
        variants: { position: 'ASC', id: 'ASC' },
      },
    });
    return products.map((product) => this.toAdminProduct(product));
  }

  async findOneForAdmin(id: number): Promise<AdminProduct> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: { category: true, brand: true, images: true, variants: true },
      order: {
        images: { isPrimary: 'DESC', position: 'ASC', id: 'ASC' },
        variants: { position: 'ASC', id: 'ASC' },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return this.toAdminProduct(product);
  }

  async findBySlug(slug: string): Promise<PublicProduct> {
    const { entities, raw } = await this.productsRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.images', 'image')
      .leftJoinAndSelect(
        'product.variants',
        'variant',
        'variant.isActive = true',
      )
      .where('product.slug = :slug', { slug })
      .andWhere('product.status = :status', {
        status: ProductStatus.ACTIVE,
      })
      .addSelect(
        '(SELECT ROUND(AVG(r."rating")::numeric, 2) FROM "product_reviews" r WHERE r."productId" = product.id AND r."isVisible" = true)',
        'averageRating',
      )
      .addSelect(
        '(SELECT COUNT(*)::int FROM "product_reviews" r WHERE r."productId" = product.id AND r."isVisible" = true)',
        'reviewCount',
      )
      .orderBy('image.isPrimary', 'DESC')
      .addOrderBy('image.position', 'ASC')
      .addOrderBy('image.id', 'ASC')
      .addOrderBy('variant.position', 'ASC')
      .addOrderBy('variant.id', 'ASC')
      .getRawAndEntities<ProductRatingRaw>();
    const product = entities[0];
    if (!product) throw new NotFoundException('Product not found');
    const rating = raw[0];
    if (!rating) throw new Error('Product rating row is missing');
    const variants = product.variants ?? [];
    const prices = variants.map((variant) => variant.price);
    return this.toPublicProduct(product, {
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      inStock: variants.some((variant) => variant.stock > 0),
      averageRating:
        rating.averageRating === null ? null : Number(rating.averageRating),
      reviewCount: Number(rating.reviewCount),
      variants: variants.map(
        ({ id, sku, name, price, stock, attributes, position }) => ({
          id,
          sku,
          name,
          price,
          stock,
          attributes,
          position,
        }),
      ),
    });
  }

  async update(id: number, dto: UpdateProductDto): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: { category: true, brand: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    if (dto.categoryId !== undefined) {
      const category = await this.findCategory(dto.categoryId);
      product.categoryId = category.id;
      product.category = category;
    }
    if (dto.brandId !== undefined) {
      const brand =
        dto.brandId === null ? null : await this.findBrand(dto.brandId);
      product.brandId = brand?.id ?? null;
      product.brand = brand;
    }

    if (dto.name !== undefined) product.name = dto.name;
    if (dto.description !== undefined) product.description = dto.description;
    if (dto.status !== undefined) product.status = dto.status;
    return this.productsRepository.save(product);
  }

  async remove(id: number): Promise<void> {
    const images = await this.productImagesRepository.find({
      where: { productId: id },
      select: { id: true, storageKey: true },
    });
    try {
      const result = await this.productsRepository.delete(id);
      if (!result.affected) throw new NotFoundException('Product not found');
    } catch (error) {
      if (isForeignKeyViolation(error))
        throw new ConflictException('Product is referenced by order history');
      throw error;
    }

    for (const image of images) {
      if (!image.storageKey) continue;
      try {
        await this.imageStorage.deleteImage(image.storageKey);
      } catch {
        this.logger.error(
          `Failed to clean up storage for image ${image.id} after deleting product ${id}`,
        );
      }
    }
  }

  private async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOneBy({ id });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  private async findBrand(id: number): Promise<Brand> {
    const brand = await this.brandsRepository.findOneBy({ id });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  private toPublicProduct(
    product: Product,
    summary: Pick<
      PublicProduct,
      | 'minPrice'
      | 'maxPrice'
      | 'inStock'
      | 'averageRating'
      | 'reviewCount'
      | 'variants'
    >,
  ): PublicProduct {
    const { images = [] } = product;
    const fields: Omit<Product, 'images' | 'variants'> = {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      status: product.status,
      categoryId: product.categoryId,
      category: product.category,
      brandId: product.brandId,
      brand: product.brand,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
    return {
      ...fields,
      ...summary,
      images: images.map((image) => this.toPublicProductImage(image)),
    };
  }

  private toPublicProductImage(image: ProductImage): PublicProductImage {
    return {
      id: image.id,
      url: image.url,
      altText: image.altText,
      position: image.position,
      isPrimary: image.isPrimary,
      productId: image.productId,
      createdAt: image.createdAt,
    };
  }

  private toAdminProduct(product: Product): AdminProduct {
    const { images = [], variants = [], ...fields } = product;
    const activeVariants = variants.filter((variant) => variant.isActive);
    const prices = activeVariants.map((variant) => variant.price);
    return {
      ...fields,
      images: images.map((image) => ({
        id: image.id,
        url: image.url,
        altText: image.altText,
        position: image.position,
        isPrimary: image.isPrimary,
        productId: image.productId,
        createdAt: image.createdAt,
      })),
      variants: variants.map((variant) => ({
        id: variant.id,
        productId: variant.productId,
        sku: variant.sku,
        name: variant.name,
        price: variant.price,
        stock: variant.stock,
        attributes: variant.attributes,
        isActive: variant.isActive,
        position: variant.position,
        createdAt: variant.createdAt,
        updatedAt: variant.updatedAt,
      })),
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      inStock: activeVariants.some((variant) => variant.stock > 0),
    };
  }
}
