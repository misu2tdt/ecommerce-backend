import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ProductStatus } from '../products/entities/product-status.enum';
import { CollectionsService } from './collections.service';
import { CollectionProduct } from './entities/collection-product.entity';
import { Collection } from './entities/collection.entity';

// A query builder whose every step returns itself and records its arguments;
// the terminal calls answer with the given rows.
function fakeBuilder(rows: unknown[] = [], entities: unknown[] = []) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const steps = [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'setParameter',
    'orderBy',
    'addOrderBy',
    'offset',
    'limit',
    'innerJoin',
  ];
  for (const step of steps) {
    builder[step] = jest.fn((...args: unknown[]) => {
      (calls[step] ??= []).push(args);
      return builder;
    });
  }
  builder.getRawMany = jest.fn().mockResolvedValue(rows);
  builder.getRawAndEntities = jest
    .fn()
    .mockResolvedValue({ entities, raw: rows });
  builder.getCount = jest.fn().mockResolvedValue(rows.length);
  return { builder, calls };
}

function databaseError(code: string) {
  const error = new QueryFailedError('SQL', [], new Error('database error'));
  (error as unknown as { driverError: { code: string } }).driverError = {
    code,
  };
  return error;
}

function collectionRow(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 1,
    slug: 'everyday-essentials',
    name: 'Everyday Essentials',
    description: null,
    heroImageUrl: null,
    isActive: true,
    isFeatured: false,
    sortOrder: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('CollectionsService', () => {
  let repository: {
    existsBy: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: {
    getRepository: jest.Mock;
    transaction: jest.Mock;
    manager: unknown;
  };
  let service: CollectionsService;
  let detail: jest.SpyInstance;

  beforeEach(() => {
    repository = {
      existsBy: jest.fn().mockResolvedValue(false),
      findOneBy: jest.fn(),
      create: jest.fn((value: Partial<Collection>) => value),
      save: jest.fn((value: Partial<Collection>) =>
        Promise.resolve({ id: 5, ...value }),
      ),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    dataSource = {
      getRepository: jest.fn().mockReturnValue(repository),
      transaction: jest.fn(),
      manager: {},
    };
    service = new CollectionsService(dataSource as unknown as DataSource);
    // The detail view reads the database; these tests are about the writes.
    detail = jest
      .spyOn(service, 'findOneForAdmin')
      .mockImplementation((id: number) =>
        Promise.resolve({ id } as Awaited<
          ReturnType<CollectionsService['findOneForAdmin']>
        >),
      );
  });

  describe('create', () => {
    it('generates the slug from the name', async () => {
      await service.create({ name: '  Everyday Essentials  ' });

      expect(repository.existsBy).toHaveBeenCalledWith({
        slug: 'everyday-essentials',
      });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'everyday-essentials',
          name: 'Everyday Essentials',
          isActive: true,
          isFeatured: false,
          sortOrder: 0,
          description: null,
          heroImageUrl: null,
        }),
      );
      expect(detail).toHaveBeenCalledWith(5);
    });

    it('accepts a valid slug of its own instead of generating one', async () => {
      await service.create({ name: 'Layering Pieces', slug: 'layers-2026' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'layers-2026' }),
      );
    });

    it.each([
      'Not Valid',
      'under_score',
      '-leading',
      'trailing-',
      'double--dash',
    ])('rejects the slug %j', async (slug) => {
      await expect(
        service.create({ name: 'Layering Pieces', slug }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('turns an empty description into no description', async () => {
      await service.create({ name: 'Layering Pieces', description: '   ' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
      );
    });

    it('answers 409 with a clear message when the slug is taken', async () => {
      repository.existsBy.mockResolvedValue(true);

      const attempt = service.create({ name: 'Everyday Essentials' });

      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toThrow(
        "A collection with the slug 'everyday-essentials' already exists",
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('also answers 409 when a concurrent request wins the unique index', async () => {
      repository.save.mockRejectedValue(databaseError('23505'));

      await expect(
        service.create({ name: 'Everyday Essentials' }),
      ).rejects.toThrow(ConflictException);
    });

    it('passes other database errors through untouched', async () => {
      const failure = databaseError('42P01');
      repository.save.mockRejectedValue(failure);

      await expect(
        service.create({ name: 'Everyday Essentials' }),
      ).rejects.toBe(failure);
    });

    it('rejects a name that cannot form a slug', async () => {
      await expect(service.create({ name: '!!!' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('update', () => {
    it('keeps the slug when the name changes', async () => {
      const existing = collectionRow();
      repository.findOneBy.mockResolvedValue(existing);

      await service.update(1, { name: 'Brand New Name' });

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'everyday-essentials',
          name: 'Brand New Name',
        }),
      );
      expect(repository.existsBy).not.toHaveBeenCalled();
    });

    it('answers 409 when the new slug belongs to another collection', async () => {
      repository.findOneBy.mockResolvedValue(collectionRow());
      repository.existsBy.mockResolvedValue(true);

      await expect(
        service.update(1, { slug: 'layering-pieces' }),
      ).rejects.toThrow(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('does not check the slug again when it is sent unchanged', async () => {
      repository.findOneBy.mockResolvedValue(collectionRow());

      await service.update(1, { slug: 'everyday-essentials' });

      expect(repository.existsBy).not.toHaveBeenCalled();
    });

    it('clears the description and the hero image with null', async () => {
      repository.findOneBy.mockResolvedValue(
        collectionRow({
          description: 'Old',
          heroImageUrl: 'https://x.test/a.jpg',
        }),
      );

      await service.update(1, { description: null, heroImageUrl: null });

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ description: null, heroImageUrl: null }),
      );
    });

    it('answers 404 for an unknown collection', async () => {
      repository.findOneBy.mockResolvedValue(null);

      await expect(service.update(9, { name: 'Anything' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('toggleActive', () => {
    it('flips the flag in both directions', async () => {
      const existing = collectionRow({ isActive: true });
      repository.findOneBy.mockResolvedValue(existing);

      await service.toggleActive(1);
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: false }),
      );

      await service.toggleActive(1);
      expect(repository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: true }),
      );
    });
  });

  describe('replaceProducts', () => {
    let manager: {
      getRepository: jest.Mock;
      delete: jest.Mock;
      insert: jest.Mock;
      update: jest.Mock;
      createQueryBuilder: jest.Mock;
    };
    let collectionRepo: { findOne: jest.Mock };
    let productRepo: { createQueryBuilder: jest.Mock };
    const order: string[] = [];

    function existingProducts(ids: number[]) {
      productRepo.createQueryBuilder.mockReturnValue(
        fakeBuilder(ids.map((id) => ({ id }))).builder,
      );
    }

    beforeEach(() => {
      order.length = 0;
      collectionRepo = {
        findOne: jest.fn().mockResolvedValue(collectionRow()),
      };
      productRepo = { createQueryBuilder: jest.fn() };
      manager = {
        getRepository: jest.fn((entity: unknown) =>
          entity === Collection ? collectionRepo : productRepo,
        ),
        delete: jest.fn(() => {
          order.push('delete');
          return Promise.resolve();
        }),
        insert: jest.fn(() => {
          order.push('insert');
          return Promise.resolve();
        }),
        update: jest.fn(() => Promise.resolve()),
        createQueryBuilder: jest.fn().mockReturnValue(
          fakeBuilder([
            { id: 7, name: 'B', slug: 'b', status: 'active', position: 0 },
            { id: 3, name: 'A', slug: 'a', status: 'inactive', position: 1 },
          ]).builder,
        ),
      };
      dataSource.transaction.mockImplementation(
        (work: (entityManager: unknown) => Promise<unknown>) => work(manager),
      );
    });

    it('rewrites the positions 0..n-1 in the given order and returns the saved list', async () => {
      existingProducts([7, 3]);

      const saved = await service.replaceProducts(1, [7, 3]);

      expect(manager.delete).toHaveBeenCalledWith(CollectionProduct, {
        collectionId: 1,
      });
      expect(manager.insert).toHaveBeenCalledWith(CollectionProduct, [
        { collectionId: 1, productId: 7, position: 0 },
        { collectionId: 1, productId: 3, position: 1 },
      ]);
      expect(order).toEqual(['delete', 'insert']);
      expect(saved).toEqual([
        {
          id: 7,
          name: 'B',
          slug: 'b',
          status: ProductStatus.ACTIVE,
          position: 0,
        },
        {
          id: 3,
          name: 'A',
          slug: 'a',
          status: ProductStatus.INACTIVE,
          position: 1,
        },
      ]);
    });

    it('locks the collection row so two replacements run one after the other', async () => {
      existingProducts([7]);

      await service.replaceProducts(1, [7]);

      expect(collectionRepo.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('empties the collection with an empty list', async () => {
      await service.replaceProducts(1, []);

      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.insert).not.toHaveBeenCalled();
      expect(productRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rejects repeated ids before touching the database', async () => {
      const attempt = service.replaceProducts(1, [7, 3, 7]);

      await expect(attempt).rejects.toThrow(BadRequestException);
      await expect(attempt).rejects.toThrow('must not contain duplicates');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects more than 200 products before touching the database', async () => {
      const tooMany = Array.from({ length: 201 }, (_, index) => index + 1);

      await expect(service.replaceProducts(1, tooMany)).rejects.toThrow(
        'must not hold more than 200 products',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('accepts exactly 200 products', async () => {
      const limit = Array.from({ length: 200 }, (_, index) => index + 1);
      existingProducts(limit);

      await expect(service.replaceProducts(1, limit)).resolves.toBeDefined();
      expect(manager.insert).toHaveBeenCalledTimes(1);
    });

    it('names the unknown ids and leaves the old membership alone', async () => {
      existingProducts([7]);

      const attempt = service.replaceProducts(1, [7, 40, 41]);

      await expect(attempt).rejects.toThrow(BadRequestException);
      await expect(attempt).rejects.toThrow(
        'These product ids do not exist: 40, 41',
      );
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown collection', async () => {
      collectionRepo.findOne.mockResolvedValue(null);

      await expect(service.replaceProducts(9, [7])).rejects.toThrow(
        NotFoundException,
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('turns a product deleted mid-request into a 400, not a 500', async () => {
      existingProducts([7]);
      manager.insert.mockRejectedValue(databaseError('23503'));

      await expect(service.replaceProducts(1, [7])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes other database errors through untouched', async () => {
      existingProducts([7]);
      const failure = databaseError('40001');
      manager.insert.mockRejectedValue(failure);

      await expect(service.replaceProducts(1, [7])).rejects.toBe(failure);
    });
  });

  describe('public visibility rule', () => {
    it('lists only active collections that hold a visible product (active product, active variant)', async () => {
      const { builder, calls } = fakeBuilder();
      repository.createQueryBuilder.mockReturnValue(builder);

      await service.findAllPublic();

      expect(calls.where[0][0]).toBe('collection.isActive = true');
      const [exists, parameters] = calls.andWhere[0] as [string, object];
      expect(exists).toContain('EXISTS');
      expect(exists).toContain('p."status" = :visibleStatus');
      expect(exists).toContain('v."isActive" = true');
      expect(parameters).toEqual({ visibleStatus: ProductStatus.ACTIVE });
      // The product count uses the same rule.
      expect(calls.addSelect[0][0]).toContain('p."status" = :visibleStatus');
      expect(calls.addSelect[0][1]).toBe('productCount');
      expect(calls.orderBy[0]).toEqual(['collection.sortOrder', 'ASC']);
      expect(calls.addOrderBy[0]).toEqual(['collection.id', 'ASC']);
    });

    it('answers 404 for a slug the public list does not hold', async () => {
      const { builder } = fakeBuilder([], []);
      repository.createQueryBuilder.mockReturnValue(builder);

      await expect(service.findBySlugPublic('nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('maps a collection with its visible product count', async () => {
      const { builder } = fakeBuilder(
        [{ productCount: '4' }],
        [collectionRow({ isFeatured: true })],
      );
      repository.createQueryBuilder.mockReturnValue(builder);

      await expect(
        service.findBySlugPublic('everyday-essentials'),
      ).resolves.toEqual({
        id: 1,
        slug: 'everyday-essentials',
        name: 'Everyday Essentials',
        description: null,
        heroImageUrl: null,
        isFeatured: true,
        productCount: 4,
      });
    });

    it('pages with the offset and limit it is given and counts the total', async () => {
      const { builder, calls } = fakeBuilder();
      repository.createQueryBuilder.mockReturnValue(builder);

      const page = await service.findPagePublic({
        page: 3,
        limit: 5,
        offset: 10,
      });

      expect(calls.offset[0]).toEqual([10]);
      expect(calls.limit[0]).toEqual([5]);
      expect(page).toEqual({ items: [], total: 0 });
    });
  });
});
