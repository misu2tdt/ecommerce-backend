import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../catalog/database-errors';
import { createSlug } from '../catalog/slug';
import type { Paging } from '../pagination/pagination';
import { ProductStatus } from '../products/entities/product-status.enum';
import { Product } from '../products/entities/product.entity';
import {
  COLLECTION_SLUG_MAX_LENGTH,
  COLLECTION_SLUG_PATTERN,
  CreateCollectionDto,
} from './dto/create-collection.dto';
import { COLLECTION_MAX_PRODUCTS } from './dto/replace-collection-products.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { CollectionProduct } from './entities/collection-product.entity';
import { Collection } from './entities/collection.entity';

export interface PublicCollection {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  heroImageUrl: string | null;
  isFeatured: boolean;
  // Visible products only (see VISIBLE_MEMBER_SQL).
  productCount: number;
}

// A product of a collection as an admin sees it: in display order, whatever its
// status.
export interface AdminCollectionProduct {
  id: number;
  name: string;
  slug: string;
  status: ProductStatus;
  position: number;
}

export interface AdminCollection extends Omit<
  PublicCollection,
  'productCount'
> {
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  // Every product in the collection, including inactive ones.
  productCount: number;
  // The products the public sees: active, with at least one active variant.
  visibleProductCount: number;
}

export type AdminCollectionDetail = AdminCollection & {
  products: AdminCollectionProduct[];
};

interface PublicCountRaw {
  productCount: number | string;
}

interface AdminCountsRaw {
  memberCount: number | string;
  visibleCount: number | string;
}

// The rule for a product to show in a collection: it is active and has at least
// one active variant (something a shopper could actually buy). `collection` is the
// alias of the collections table in the query that embeds this.
const VISIBLE_MEMBER_SQL = `FROM "collection_products" cp
  INNER JOIN "products" p ON p."id" = cp."productId"
  WHERE cp."collectionId" = collection.id
    AND p."status" = :visibleStatus
    AND EXISTS (SELECT 1 FROM "product_variants" v WHERE v."productId" = p."id" AND v."isActive" = true)`;

@Injectable()
export class CollectionsService {
  constructor(private readonly dataSource: DataSource) {}

  private get repository(): Repository<Collection> {
    return this.dataSource.getRepository(Collection);
  }

  // --- Public ---

  // Active collections that have at least one visible product, in display order.
  async findAllPublic(): Promise<PublicCollection[]> {
    return this.loadPublic(this.publicBuilder());
  }

  async findPagePublic(
    paging: Paging,
  ): Promise<{ items: PublicCollection[]; total: number }> {
    const total = await this.publicBuilder().getCount();
    const items = await this.loadPublic(
      this.publicBuilder().offset(paging.offset).limit(paging.limit),
    );
    return { items, total };
  }

  async findBySlugPublic(slug: string): Promise<PublicCollection> {
    const [collection] = await this.loadPublic(
      this.publicBuilder().andWhere('collection.slug = :slug', { slug }),
    );
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  private publicBuilder(): SelectQueryBuilder<Collection> {
    return this.repository
      .createQueryBuilder('collection')
      .where('collection.isActive = true')
      .andWhere(`EXISTS (SELECT 1 ${VISIBLE_MEMBER_SQL})`, {
        visibleStatus: ProductStatus.ACTIVE,
      })
      .addSelect(`(SELECT COUNT(*)::int ${VISIBLE_MEMBER_SQL})`, 'productCount')
      .orderBy('collection.sortOrder', 'ASC')
      .addOrderBy('collection.id', 'ASC');
  }

  private async loadPublic(
    builder: SelectQueryBuilder<Collection>,
  ): Promise<PublicCollection[]> {
    const { entities, raw } = await builder.getRawAndEntities<PublicCountRaw>();
    return entities.map((collection, index) => ({
      id: collection.id,
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
      heroImageUrl: collection.heroImageUrl,
      isFeatured: collection.isFeatured,
      productCount: Number(raw[index]?.productCount ?? 0),
    }));
  }

  // --- Admin ---

  async findAllForAdmin(): Promise<AdminCollection[]> {
    return this.loadAdmin(this.adminBuilder());
  }

  async findPageForAdmin(
    paging: Paging,
  ): Promise<{ items: AdminCollection[]; total: number }> {
    const total = await this.repository.count();
    const items = await this.loadAdmin(
      this.adminBuilder().offset(paging.offset).limit(paging.limit),
    );
    return { items, total };
  }

  async findOneForAdmin(id: number): Promise<AdminCollectionDetail> {
    const [collection] = await this.loadAdmin(
      this.adminBuilder().andWhere('collection.id = :id', { id }),
    );
    if (!collection) throw new NotFoundException('Collection not found');
    return {
      ...collection,
      products: await this.loadMembers(this.dataSource.manager, id),
    };
  }

  async create(dto: CreateCollectionDto): Promise<AdminCollectionDetail> {
    const slug = this.resolveSlugForCreate(dto);
    if (await this.repository.existsBy({ slug })) {
      throw duplicateSlug(slug);
    }

    const collection = this.repository.create({
      slug,
      name: dto.name.trim(),
      description: blankToNull(dto.description),
      heroImageUrl: blankToNull(dto.heroImageUrl),
      isActive: dto.isActive ?? true,
      isFeatured: dto.isFeatured ?? false,
      sortOrder: dto.sortOrder ?? 0,
    });

    try {
      const saved = await this.repository.save(collection);
      return await this.findOneForAdmin(saved.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateSlug(slug);
      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdateCollectionDto,
  ): Promise<AdminCollectionDetail> {
    const collection = await this.repository.findOneBy({ id });
    if (!collection) throw new NotFoundException('Collection not found');

    let slugChanged: string | null = null;
    if (dto.slug !== undefined && dto.slug !== null) {
      const slug = validatedSlug(dto.slug);
      if (slug !== collection.slug) {
        if (await this.repository.existsBy({ slug })) {
          throw duplicateSlug(slug);
        }
        collection.slug = slug;
        slugChanged = slug;
      }
    }
    // The slug is not regenerated when the name changes: addresses stay stable.
    if (dto.name !== undefined) collection.name = dto.name.trim();
    if (dto.description !== undefined) {
      collection.description = blankToNull(dto.description);
    }
    if (dto.heroImageUrl !== undefined) {
      collection.heroImageUrl = blankToNull(dto.heroImageUrl);
    }
    if (dto.isActive !== undefined) collection.isActive = dto.isActive;
    if (dto.isFeatured !== undefined) collection.isFeatured = dto.isFeatured;
    if (dto.sortOrder !== undefined) collection.sortOrder = dto.sortOrder;

    try {
      await this.repository.save(collection);
    } catch (error) {
      if (slugChanged !== null && isUniqueViolation(error)) {
        throw duplicateSlug(slugChanged);
      }
      throw error;
    }
    return this.findOneForAdmin(id);
  }

  async toggleActive(id: number): Promise<AdminCollectionDetail> {
    const collection = await this.repository.findOneBy({ id });
    if (!collection) throw new NotFoundException('Collection not found');
    collection.isActive = !collection.isActive;
    await this.repository.save(collection);
    return this.findOneForAdmin(id);
  }

  // Replaces the whole membership: the new list, in the given order, is the
  // collection's product list from position 0. Everything happens in one
  // transaction, so a failure anywhere leaves the old membership as it was.
  // Inactive products are allowed here (an admin sees them); the public
  // endpoints hide them.
  async replaceProducts(
    id: number,
    productIds: number[],
  ): Promise<AdminCollectionProduct[]> {
    assertValidProductIds(productIds);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Locking the collection row makes two replacements of the same
        // collection run one after the other.
        const collection = await manager.getRepository(Collection).findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!collection) throw new NotFoundException('Collection not found');

        if (productIds.length > 0) {
          const found = await manager
            .getRepository(Product)
            .createQueryBuilder('product')
            .select('product.id', 'id')
            .where('product.id IN (:...productIds)', { productIds })
            .getRawMany<{ id: number }>();
          const known = new Set(found.map((row) => Number(row.id)));
          const unknown = productIds.filter(
            (productId) => !known.has(productId),
          );
          if (unknown.length > 0) throw unknownProducts(unknown);
        }

        await manager.delete(CollectionProduct, { collectionId: id });
        if (productIds.length > 0) {
          await manager.insert(
            CollectionProduct,
            productIds.map((productId, position) => ({
              collectionId: id,
              productId,
              position,
            })),
          );
        }
        await manager.update(
          Collection,
          { id },
          { updatedAt: () => 'CURRENT_TIMESTAMP' },
        );
        return this.loadMembers(manager, id);
      });
    } catch (error) {
      // A product deleted between the check and the insert.
      if (isForeignKeyViolation(error)) {
        throw new BadRequestException(
          'One of the products no longer exists. Reload the product list and try again.',
        );
      }
      throw error;
    }
  }

  private adminBuilder(): SelectQueryBuilder<Collection> {
    return this.repository
      .createQueryBuilder('collection')
      .addSelect(
        `(SELECT COUNT(*)::int FROM "collection_products" m WHERE m."collectionId" = collection.id)`,
        'memberCount',
      )
      .addSelect(`(SELECT COUNT(*)::int ${VISIBLE_MEMBER_SQL})`, 'visibleCount')
      .setParameter('visibleStatus', ProductStatus.ACTIVE)
      .orderBy('collection.sortOrder', 'ASC')
      .addOrderBy('collection.id', 'ASC');
  }

  private async loadAdmin(
    builder: SelectQueryBuilder<Collection>,
  ): Promise<AdminCollection[]> {
    const { entities, raw } = await builder.getRawAndEntities<AdminCountsRaw>();
    return entities.map((collection, index) => ({
      id: collection.id,
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
      heroImageUrl: collection.heroImageUrl,
      isFeatured: collection.isFeatured,
      isActive: collection.isActive,
      sortOrder: collection.sortOrder,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      productCount: Number(raw[index]?.memberCount ?? 0),
      visibleProductCount: Number(raw[index]?.visibleCount ?? 0),
    }));
  }

  private async loadMembers(
    manager: EntityManager,
    collectionId: number,
  ): Promise<AdminCollectionProduct[]> {
    const rows = await manager
      .createQueryBuilder(CollectionProduct, 'member')
      .innerJoin('member.product', 'product')
      .select([
        'product.id AS id',
        'product.name AS name',
        'product.slug AS slug',
        'product.status AS status',
        'member.position AS position',
      ])
      .where('member.collectionId = :collectionId', { collectionId })
      .orderBy('member.position', 'ASC')
      .addOrderBy('product.id', 'ASC')
      .getRawMany<AdminCollectionProduct>();
    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      status: row.status,
      position: Number(row.position),
    }));
  }

  private resolveSlugForCreate(dto: CreateCollectionDto): string {
    if (dto.slug !== undefined && dto.slug !== null) {
      return validatedSlug(dto.slug);
    }
    return createSlug(dto.name);
  }
}

function duplicateSlug(slug: string): ConflictException {
  return new ConflictException(
    `A collection with the slug '${slug}' already exists. Choose another name or slug.`,
  );
}

function unknownProducts(ids: number[]): BadRequestException {
  return new BadRequestException(
    `These product ids do not exist: ${ids.join(', ')}`,
  );
}

// The same rules as the DTO, for callers that do not go through validation.
function validatedSlug(value: string): string {
  const slug = value.trim();
  if (
    slug.length === 0 ||
    slug.length > COLLECTION_SLUG_MAX_LENGTH ||
    !COLLECTION_SLUG_PATTERN.test(slug)
  ) {
    throw new BadRequestException(
      'slug may only contain lowercase letters and numbers joined by single dashes',
    );
  }
  return slug;
}

function assertValidProductIds(productIds: number[]): void {
  if (productIds.length > COLLECTION_MAX_PRODUCTS) {
    throw new BadRequestException(
      `productIds must not hold more than ${COLLECTION_MAX_PRODUCTS} products`,
    );
  }
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const productId of productIds) {
    if (seen.has(productId)) repeated.add(productId);
    seen.add(productId);
  }
  if (repeated.size > 0) {
    throw new BadRequestException(
      `productIds must not contain duplicates (repeated: ${[...repeated].join(', ')})`,
    );
  }
}

// An empty text means "no value".
function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
