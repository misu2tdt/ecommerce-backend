import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../catalog/database-errors';
import { CreateProductVariantDto } from './dto/create-product-variant.dto';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto';
import { ProductVariant } from './entities/product-variant.entity';
import { Product } from './entities/product.entity';

@Injectable()
export class ProductVariantsService {
  constructor(
    @InjectRepository(ProductVariant)
    private readonly variantsRepository: Repository<ProductVariant>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
  ) {}

  async createForProduct(
    productId: number,
    dto: CreateProductVariantDto,
  ): Promise<ProductVariant> {
    if (!(await this.productsRepository.existsBy({ id: productId })))
      throw new NotFoundException('Product not found');
    const sku = dto.sku.trim().toUpperCase();
    if (await this.variantsRepository.existsBy({ sku }))
      throw new ConflictException('Variant SKU already exists');

    if (
      dto.compareAtPrice !== undefined &&
      dto.compareAtPrice !== null &&
      dto.compareAtPrice <= dto.price
    ) {
      throw new BadRequestException(
        'compareAtPrice must be greater than price',
      );
    }

    try {
      return await this.variantsRepository.save(
        this.variantsRepository.create({
          ...dto,
          sku,
          productId,
          compareAtPrice: dto.compareAtPrice ?? null,
          attributes: dto.attributes ?? {},
          isActive: dto.isActive ?? true,
          position: dto.position ?? 0,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('Variant SKU already exists');
      throw error;
    }
  }

  async updateForProduct(
    productId: number,
    variantId: number,
    dto: UpdateProductVariantDto,
  ): Promise<ProductVariant> {
    await this.requireProduct(productId);
    const variant = await this.variantsRepository.findOneBy({
      id: variantId,
      productId,
    });
    if (!variant) throw new NotFoundException('Product variant not found');

    const effectivePrice = dto.price !== undefined ? dto.price : variant.price;
    const effectiveCompareAtPrice =
      dto.compareAtPrice !== undefined
        ? dto.compareAtPrice
        : variant.compareAtPrice;

    if (
      effectiveCompareAtPrice !== null &&
      effectiveCompareAtPrice !== undefined &&
      effectiveCompareAtPrice <= effectivePrice
    ) {
      throw new BadRequestException(
        'compareAtPrice must be greater than price',
      );
    }

    Object.assign(variant, dto);
    return this.variantsRepository.save(variant);
  }

  async removeForProduct(productId: number, variantId: number): Promise<void> {
    await this.requireProduct(productId);
    try {
      const result = await this.variantsRepository.delete({
        id: variantId,
        productId,
      });
      if (!result.affected)
        throw new NotFoundException('Product variant not found');
    } catch (error) {
      if (isForeignKeyViolation(error))
        throw new ConflictException('Variant is referenced by order history');
      throw error;
    }
  }

  private async requireProduct(productId: number): Promise<void> {
    if (!(await this.productsRepository.existsBy({ id: productId })))
      throw new NotFoundException('Product not found');
  }
}
