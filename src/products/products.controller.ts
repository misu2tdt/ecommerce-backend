import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/entities/user-role.enum';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductImageDto } from './dto/create-product-image.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { UpdateProductImageDto } from './dto/update-product-image.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductImagesService } from './product-images.service';
import { ProductVariantsService } from './product-variants.service';
import { CreateProductVariantDto } from './dto/create-product-variant.dto';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto';
import { ProductImageUploadInterceptor } from './product-image-upload';
import { ProductsService } from './products.service';
import {
  publicProductDetailSchema,
  publicProductListSchema,
} from '../docs/swagger-schemas';

@Controller('products')
@ApiTags('Catalog - Products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly productImagesService: ProductImagesService,
    private readonly productVariantsService: ProductVariantsService,
  ) {}

  @Post(':productId/variants')
  @ApiTags('Catalog - Product Variants')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Create a purchasable ProductVariant SKU',
    description: 'ADMIN only. Price is integer VND.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createVariant(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: CreateProductVariantDto,
  ) {
    return this.productVariantsService.createForProduct(productId, dto);
  }

  @Patch(':productId/variants/:variantId')
  @ApiTags('Catalog - Product Variants')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Update a ProductVariant',
    description: 'ADMIN only.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateVariant(
    @Param('productId', ParseIntPipe) productId: number,
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: UpdateProductVariantDto,
  ) {
    return this.productVariantsService.updateForProduct(
      productId,
      variantId,
      dto,
    );
  }

  @Delete(':productId/variants/:variantId')
  @ApiTags('Catalog - Product Variants')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Delete a ProductVariant',
    description: 'ADMIN only.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  removeVariant(
    @Param('productId', ParseIntPipe) productId: number,
    @Param('variantId', ParseIntPipe) variantId: number,
  ) {
    return this.productVariantsService.removeForProduct(productId, variantId);
  }

  @Post(':productId/images')
  @ApiTags('Catalog - Product Images')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Upload a product image',
    description: 'ADMIN only.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        altText: { type: 'string', example: 'Front view of the product' },
        position: { type: 'integer', minimum: 0, example: 0 },
        isPrimary: { type: 'boolean', example: true },
      },
    },
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(ProductImageUploadInterceptor)
  createImage(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: CreateProductImageDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.productImagesService.uploadForProduct(productId, dto, file);
  }

  @Patch(':productId/images/:imageId')
  @ApiTags('Catalog - Product Images')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Update product image metadata',
    description: 'ADMIN only.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateImage(
    @Param('productId', ParseIntPipe) productId: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() dto: UpdateProductImageDto,
  ) {
    return this.productImagesService.updateForProduct(productId, imageId, dto);
  }

  @Delete(':productId/images/:imageId')
  @ApiTags('Catalog - Product Images')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Delete a product image',
    description: 'ADMIN only.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  removeImage(
    @Param('productId', ParseIntPipe) productId: number,
    @Param('imageId', ParseIntPipe) imageId: number,
  ) {
    return this.productImagesService.removeForProduct(productId, imageId);
  }

  @Get('admin')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'List all Products for catalog administration',
    description:
      'ADMIN only. Includes inactive Products and Variants, all image metadata, and excludes storage keys.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findAllForAdmin() {
    return this.productsService.findAllForAdmin();
  }

  @Get('admin/:id')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Get a Product for catalog administration',
    description:
      'ADMIN only. Includes inactive Variants, all image metadata, and excludes storage keys.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findOneForAdmin(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.findOneForAdmin(id);
  }

  @Post()
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Create a catalog Product parent',
    description:
      'ADMIN only. Purchasable inventory belongs to ProductVariants.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Update a Product parent',
    description: 'ADMIN only.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Delete a Product parent',
    description: 'ADMIN only.',
  })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.remove(id);
  }

  @Get('filters')
  @ApiOperation({
    summary: 'Get available catalog filter facets and options',
    description:
      'Returns categories, brands, available sizes, colors, and min/max price range from active catalog variants.',
  })
  getFilterOptions() {
    return this.productsService.getFilterOptions();
  }

  @Get('slug/:slug')
  @ApiOkResponse({ schema: publicProductDetailSchema })
  @ApiOperation({
    summary: 'Get public Product detail by slug',
    description:
      'Returns active variants with SKU, integer-VND price, stock and attributes, plus minPrice, maxPrice, inStock, averageRating and reviewCount.',
  })
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }

  @Get()
  @ApiOkResponse({ schema: publicProductListSchema })
  @ApiOperation({
    summary: 'List active public Products',
    description:
      'Supports category/brand slug and text filters. Includes minPrice, maxPrice, inStock, averageRating and reviewCount.',
  })
  findAll(@Query() query: ProductQueryDto) {
    return this.productsService.findAll(query);
  }
}
