import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureHttpSecurity } from '../../src/config/http-security';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import { createBrand, createCategory, createVariant } from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const FRONTEND_ORIGIN = 'https://shop.example.test';

interface CollectionBody {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  heroImageUrl: string | null;
  isFeatured: boolean;
  productCount: number;
}

interface MemberBody {
  id: number;
  name: string;
  slug: string;
  status: string;
  position: number;
}

// Collections against the real test database: constraints, the public and the
// admin API, the all-or-nothing membership replacement, and /products?collection.
describe('Collections', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let customerToken: string;

  // Products by name. Alpha..Golf are active with an active variant. "Hotel" is
  // inactive, "India" has only an inactive variant, "Juliet" has no variant.
  const product: Record<string, Product> = {};

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    await cleanTestDatabase(dataSource);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpSecurity(expressApp, {
      nodeEnvironment: 'production',
      frontendOrigin: FRONTEND_ORIGIN,
    });
    expressApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await expressApp.init();
    app = expressApp;
    const jwt = app.get(JwtService);

    const users = dataSource.getRepository(User);
    const admin = await users.save({
      email: 'collections-admin@example.test',
      password: 'not-used',
      role: UserRole.ADMIN,
    });
    const customer = await users.save({
      email: 'collections-customer@example.test',
      password: 'not-used',
      role: UserRole.USER,
    });
    const sign = (user: User) =>
      jwt.sign({ sub: user.id, email: user.email, role: user.role });
    adminToken = sign(admin);
    customerToken = sign(customer);

    await seedProducts();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    // Every test starts with no collections; products stay.
    await dataSource.query('DELETE FROM "collections"');
  });

  async function seedProducts() {
    const category = await createCategory(dataSource, 'collections');
    const brand = await createBrand(dataSource, 'collections');
    const repository = dataSource.getRepository(Product);
    const names: Array<[string, ProductStatus]> = [
      ['Alpha', ProductStatus.ACTIVE],
      ['Bravo', ProductStatus.ACTIVE],
      ['Charlie', ProductStatus.ACTIVE],
      ['Delta', ProductStatus.ACTIVE],
      ['Echo', ProductStatus.ACTIVE],
      ['Foxtrot', ProductStatus.ACTIVE],
      ['Golf', ProductStatus.ACTIVE],
      ['Hotel', ProductStatus.INACTIVE],
      ['India', ProductStatus.ACTIVE],
      ['Juliet', ProductStatus.ACTIVE],
    ];
    for (const [name, status] of names) {
      product[name] = await repository.save({
        name,
        slug: name.toLowerCase(),
        description: null,
        status,
        categoryId: category.id,
        brandId: brand.id,
      });
    }
    // Prices differ so a price sort differs from the name sort.
    const prices: Record<string, number> = {
      Alpha: 500_000,
      Bravo: 100_000,
      Charlie: 300_000,
      Delta: 200_000,
      Echo: 400_000,
      Foxtrot: 150_000,
      Golf: 250_000,
      Hotel: 120_000,
    };
    for (const [name, price] of Object.entries(prices)) {
      await createVariant(dataSource, product[name], name, { price });
    }
    // India: only an inactive variant. Juliet: no variant at all.
    await createVariant(dataSource, product.India, 'India', {
      isActive: false,
    });
  }

  const idOf = (name: string) => product[name].id;
  const idsOf = (...names: string[]) => names.map(idOf);

  const http = () => request(app.getHttpServer());
  const asAdmin = (call: request.Test) =>
    call.set('Authorization', `Bearer ${adminToken}`);

  async function createCollection(
    body: Record<string, unknown>,
  ): Promise<CollectionBody & { isActive: boolean; sortOrder: number }> {
    const res = await asAdmin(http().post('/admin/collections'))
      .send(body)
      .expect(201);
    return res.body as CollectionBody & {
      isActive: boolean;
      sortOrder: number;
    };
  }

  async function setProducts(id: number, names: string[]) {
    return asAdmin(http().put(`/admin/collections/${id}/products`))
      .send({ productIds: idsOf(...names) })
      .expect(200);
  }

  async function memberIds(collectionId: number): Promise<number[]> {
    const rows = await dataSource.query<Array<{ productId: number }>>(
      `SELECT "productId" FROM collection_products WHERE "collectionId" = $1 ORDER BY position`,
      [collectionId],
    );
    return rows.map((row) => row.productId);
  }

  const publicNames = (body: unknown) =>
    (body as Array<{ name: string }>).map((item) => item.name);

  describe('database constraints', () => {
    async function insertCollection(slug: string): Promise<number> {
      const rows = await dataSource.query<Array<{ id: number }>>(
        `INSERT INTO collections (slug, name) VALUES ($1, $1) RETURNING id`,
        [slug],
      );
      return rows[0].id;
    }
    const member = (
      collectionId: number,
      productId: number,
      position: number,
    ) =>
      dataSource.query(
        `INSERT INTO collection_products ("collectionId", "productId", position) VALUES ($1, $2, $3)`,
        [collectionId, productId, position],
      );
    const memberCount = async () =>
      Number(
        (
          await dataSource.query<Array<{ count: string }>>(
            `SELECT COUNT(*) AS count FROM collection_products`,
          )
        )[0].count,
      );

    it('applies the defaults: active, not featured, sort order 0', async () => {
      const id = await insertCollection('defaults');

      const [row] = await dataSource.query<
        Array<{
          isActive: boolean;
          isFeatured: boolean;
          sortOrder: number;
          description: string | null;
          heroImageUrl: string | null;
        }>
      >(`SELECT * FROM collections WHERE id = $1`, [id]);

      expect(row).toMatchObject({
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        description: null,
        heroImageUrl: null,
      });
    });

    it('keeps slugs unique', async () => {
      await insertCollection('same-slug');

      await expect(insertCollection('same-slug')).rejects.toMatchObject({
        driverError: { code: '23505' },
      });
    });

    it('allows a product once per collection (composite primary key) but in many collections', async () => {
      const first = await insertCollection('first');
      const second = await insertCollection('second');
      await member(first, idOf('Alpha'), 0);

      await expect(member(first, idOf('Alpha'), 1)).rejects.toMatchObject({
        driverError: { code: '23505' },
      });
      await member(second, idOf('Alpha'), 0);
      expect(await memberCount()).toBe(2);
    });

    it('refuses a negative position', async () => {
      const id = await insertCollection('negative');

      await expect(member(id, idOf('Alpha'), -1)).rejects.toMatchObject({
        driverError: { code: '23514' },
      });
      await member(id, idOf('Alpha'), 0);
    });

    it('refuses a product or a collection that does not exist', async () => {
      const id = await insertCollection('dangling');

      await expect(member(id, 999_999, 0)).rejects.toMatchObject({
        driverError: { code: '23503' },
      });
      await expect(member(999_999, idOf('Alpha'), 0)).rejects.toMatchObject({
        driverError: { code: '23503' },
      });
    });

    it('removes memberships, not collections, when a product is deleted', async () => {
      const id = await insertCollection('product-cascade');
      const doomed = await dataSource.getRepository(Product).save({
        name: 'Doomed',
        slug: 'doomed',
        description: null,
        status: ProductStatus.ACTIVE,
        categoryId: product.Alpha.categoryId,
        brandId: null,
      });
      await member(id, doomed.id, 0);
      await member(id, idOf('Bravo'), 1);

      await dataSource.getRepository(Product).delete(doomed.id);

      expect(await memberIds(id)).toEqual([idOf('Bravo')]);
      expect(
        await dataSource.query(`SELECT id FROM collections WHERE id = $1`, [
          id,
        ]),
      ).toHaveLength(1);
    });

    it('removes memberships, not products, when a collection is deleted', async () => {
      const id = await insertCollection('collection-cascade');
      await member(id, idOf('Alpha'), 0);
      await member(id, idOf('Bravo'), 1);

      await dataSource.query(`DELETE FROM collections WHERE id = $1`, [id]);

      expect(await memberCount()).toBe(0);
      expect(
        await dataSource.query(`SELECT id FROM products WHERE id = ANY($1)`, [
          idsOf('Alpha', 'Bravo'),
        ]),
      ).toHaveLength(2);
    });
  });

  describe('who may use the admin API', () => {
    // Every row has three items: jest-each passes a callback ("done") as the
    // next argument when a row is shorter, which breaks the request.
    const calls: Array<[string, string, Record<string, unknown> | undefined]> =
      [
        ['get', '/admin/collections', undefined],
        ['get', '/admin/collections/1', undefined],
        ['post', '/admin/collections', { name: 'Not Allowed' }],
        ['patch', '/admin/collections/1', { name: 'Not Allowed' }],
        ['patch', '/admin/collections/1/toggle', undefined],
        ['put', '/admin/collections/1/products', { productIds: [] }],
      ];

    it.each(calls)('%s %s needs a token', async (method, path, body) => {
      const call = (
        http() as unknown as Record<string, (url: string) => request.Test>
      )[method](path);
      await (body ? call.send(body) : call).expect(401);
    });

    it.each(calls)(
      '%s %s is refused to a customer',
      async (method, path, body) => {
        const call = (
          http() as unknown as Record<string, (url: string) => request.Test>
        )
          [method](path)
          .set('Authorization', `Bearer ${customerToken}`);
        await (body ? call.send(body) : call).expect(403);
      },
    );

    it('changes nothing when a customer tries to create a collection', async () => {
      await http()
        .post('/admin/collections')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'Sneaky' })
        .expect(403);

      expect(await dataSource.query(`SELECT id FROM collections`)).toHaveLength(
        0,
      );
    });
  });

  describe('admin: create, read, update, toggle', () => {
    it('creates a collection with a slug made from its name and the defaults', async () => {
      const created = await createCollection({
        name: '  Everyday Essentials ',
      });

      expect(created).toMatchObject({
        slug: 'everyday-essentials',
        name: 'Everyday Essentials',
        description: null,
        heroImageUrl: null,
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        productCount: 0,
        visibleProductCount: 0,
        products: [],
      });
    });

    it('accepts a valid slug of its own and every optional field', async () => {
      const created = await createCollection({
        name: 'Layering Pieces',
        slug: 'layers',
        description: 'Light jackets.',
        heroImageUrl: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
        isActive: false,
        isFeatured: true,
        sortOrder: 7,
      });

      expect(created).toMatchObject({
        slug: 'layers',
        description: 'Light jackets.',
        heroImageUrl: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
        isActive: false,
        isFeatured: true,
        sortOrder: 7,
      });
    });

    it('answers 409 with a clear message for a duplicate slug, whether generated or sent', async () => {
      await createCollection({ name: 'Everyday Essentials' });

      const generated = await asAdmin(http().post('/admin/collections'))
        .send({ name: 'Everyday   Essentials!' })
        .expect(409);
      expect(generated.body.message).toContain(
        "A collection with the slug 'everyday-essentials' already exists",
      );

      await asAdmin(http().post('/admin/collections'))
        .send({ name: 'Something Else', slug: 'everyday-essentials' })
        .expect(409);
      expect(await dataSource.query(`SELECT id FROM collections`)).toHaveLength(
        1,
      );
    });

    it.each([
      [{}, 'name'],
      [{ name: 'a' }, 'name'],
      [{ name: 'Valid', slug: 'Not Valid' }, 'slug'],
      [{ name: 'Valid', heroImageUrl: 'ftp://x.test/a.jpg' }, 'heroImageUrl'],
      [{ name: 'Valid', sortOrder: -1 }, 'sortOrder'],
      [{ name: 'Valid', isActive: 'yes' }, 'isActive'],
      [{ name: 'Valid', productIds: [1] }, 'productIds'],
    ])('rejects %j with a message about %s', async (body, field) => {
      const res = await asAdmin(http().post('/admin/collections'))
        .send(body)
        .expect(400);

      expect((res.body.message as string[]).join(' ')).toContain(field);
    });

    it('lists collections, including inactive ones, with both counts', async () => {
      const visible = await createCollection({ name: 'Visible', sortOrder: 1 });
      const hidden = await createCollection({
        name: 'Hidden',
        isActive: false,
        sortOrder: 0,
      });
      // Hotel is inactive; India has no active variant.
      await setProducts(visible.id, ['Alpha', 'Hotel', 'India', 'Bravo']);

      const res = await asAdmin(http().get('/admin/collections')).expect(200);

      expect(
        (res.body as Array<{ name: string }>).map((item) => item.name),
      ).toEqual(['Hidden', 'Visible']);
      expect(res.body[0]).toMatchObject({
        id: hidden.id,
        isActive: false,
        productCount: 0,
        visibleProductCount: 0,
      });
      expect(res.body[1]).toMatchObject({
        id: visible.id,
        productCount: 4,
        visibleProductCount: 2,
      });
      expect(res.headers['x-total-count']).toBeUndefined();
    });

    it('pages the admin list with the standard headers', async () => {
      for (const name of ['One', 'Two', 'Three']) {
        await createCollection({ name });
      }

      const res = await asAdmin(
        http().get('/admin/collections?page=2&limit=2'),
      ).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.headers['x-total-count']).toBe('3');
      expect(res.headers['x-total-pages']).toBe('2');
      expect(res.headers['x-page']).toBe('2');
      expect(res.headers['x-limit']).toBe('2');
      await asAdmin(http().get('/admin/collections?limit=101')).expect(400);
    });

    it('reads one collection with its products in display order, inactive ones included', async () => {
      const created = await createCollection({ name: 'Detail' });
      await setProducts(created.id, ['Charlie', 'Hotel', 'Alpha']);

      const res = await asAdmin(
        http().get(`/admin/collections/${created.id}`),
      ).expect(200);

      expect(
        (res.body.products as MemberBody[]).map((item) => [
          item.name,
          item.status,
          item.position,
        ]),
      ).toEqual([
        ['Charlie', 'active', 0],
        ['Hotel', 'inactive', 1],
        ['Alpha', 'active', 2],
      ]);
      await asAdmin(http().get('/admin/collections/999999')).expect(404);
    });

    it('updates fields without changing the slug, and clears optional text with null', async () => {
      const created = await createCollection({
        name: 'Old Name',
        description: 'Old text',
        heroImageUrl: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
      });

      const res = await asAdmin(
        http().patch(`/admin/collections/${created.id}`),
      )
        .send({
          name: 'New Name',
          description: null,
          heroImageUrl: null,
          isFeatured: true,
          sortOrder: 4,
        })
        .expect(200);

      expect(res.body).toMatchObject({
        slug: 'old-name',
        name: 'New Name',
        description: null,
        heroImageUrl: null,
        isFeatured: true,
        sortOrder: 4,
      });
    });

    it('changes the slug on request, and answers 409 when another collection has it', async () => {
      const first = await createCollection({ name: 'First' });
      await createCollection({ name: 'Second' });

      const changed = await asAdmin(
        http().patch(`/admin/collections/${first.id}`),
      )
        .send({ slug: 'first-renamed' })
        .expect(200);
      expect(changed.body.slug).toBe('first-renamed');

      await asAdmin(http().patch(`/admin/collections/${first.id}`))
        .send({ slug: 'second' })
        .expect(409);
      // Its own slug again is not a conflict.
      await asAdmin(http().patch(`/admin/collections/${first.id}`))
        .send({ slug: 'first-renamed' })
        .expect(200);
      await asAdmin(http().patch('/admin/collections/999999'))
        .send({ name: 'Nothing' })
        .expect(404);
    });

    it('toggles the active flag both ways', async () => {
      const created = await createCollection({ name: 'Toggle me' });

      const off = await asAdmin(
        http().patch(`/admin/collections/${created.id}/toggle`),
      ).expect(200);
      expect(off.body.isActive).toBe(false);

      const on = await asAdmin(
        http().patch(`/admin/collections/${created.id}/toggle`),
      ).expect(200);
      expect(on.body.isActive).toBe(true);
      await asAdmin(http().patch('/admin/collections/999999/toggle')).expect(
        404,
      );
    });
  });

  describe('admin: replacing the products of a collection', () => {
    it('saves the order, rewrites positions 0..n-1 and returns the saved list', async () => {
      const created = await createCollection({ name: 'Ordered' });

      const res = await setProducts(created.id, ['Echo', 'Alpha', 'Charlie']);

      expect(
        (res.body as MemberBody[]).map((item) => [item.name, item.position]),
      ).toEqual([
        ['Echo', 0],
        ['Alpha', 1],
        ['Charlie', 2],
      ]);
      expect(await memberIds(created.id)).toEqual(
        idsOf('Echo', 'Alpha', 'Charlie'),
      );
    });

    it('replaces the whole membership, not just adds to it', async () => {
      const created = await createCollection({ name: 'Replaced' });
      await setProducts(created.id, ['Alpha', 'Bravo', 'Charlie']);

      await setProducts(created.id, ['Delta', 'Charlie']);

      expect(await memberIds(created.id)).toEqual(idsOf('Delta', 'Charlie'));
      const rows = await dataSource.query<Array<{ position: number }>>(
        `SELECT position FROM collection_products WHERE "collectionId" = $1 ORDER BY position`,
        [created.id],
      );
      expect(rows.map((row) => row.position)).toEqual([0, 1]);
    });

    it('empties the collection with an empty list', async () => {
      const created = await createCollection({ name: 'Emptied' });
      await setProducts(created.id, ['Alpha']);

      const res = await setProducts(created.id, []);

      expect(res.body).toEqual([]);
      expect(await memberIds(created.id)).toEqual([]);
    });

    it('accepts inactive products, and keeps them out of the public endpoints', async () => {
      const created = await createCollection({ name: 'With Hotel' });

      const res = await setProducts(created.id, ['Alpha', 'Hotel']);

      expect((res.body as MemberBody[]).map((item) => item.status)).toEqual([
        'active',
        'inactive',
      ]);
      const publicList = await http()
        .get('/products?collection=with-hotel')
        .expect(200);
      expect(publicNames(publicList.body)).toEqual(['Alpha']);
      const collection = await http()
        .get('/collections/with-hotel')
        .expect(200);
      expect(collection.body.productCount).toBe(1);
    });

    it('rejects repeated ids and leaves the old membership as it was', async () => {
      const created = await createCollection({ name: 'Repeats' });
      await setProducts(created.id, ['Alpha', 'Bravo']);

      const res = await asAdmin(
        http().put(`/admin/collections/${created.id}/products`),
      )
        .send({ productIds: idsOf('Charlie', 'Delta', 'Charlie') })
        .expect(400);

      expect(res.body.message).toContain('must not contain duplicates');
      expect(await memberIds(created.id)).toEqual(idsOf('Alpha', 'Bravo'));
    });

    it('rejects ids that do not exist, names them, and leaves the old membership as it was', async () => {
      const created = await createCollection({ name: 'Unknown ids' });
      await setProducts(created.id, ['Alpha', 'Bravo']);

      const res = await asAdmin(
        http().put(`/admin/collections/${created.id}/products`),
      )
        .send({ productIds: [idOf('Charlie'), 999_998, 999_999] })
        .expect(400);

      expect(res.body.message).toContain(
        'These product ids do not exist: 999998, 999999',
      );
      expect(await memberIds(created.id)).toEqual(idsOf('Alpha', 'Bravo'));
    });

    it('caps the list at 200 products', async () => {
      const created = await createCollection({ name: 'Capped' });
      await setProducts(created.id, ['Alpha']);

      const res = await asAdmin(
        http().put(`/admin/collections/${created.id}/products`),
      )
        .send({
          productIds: Array.from({ length: 201 }, (_, index) => index + 1),
        })
        .expect(400);

      expect((res.body.message as string[]).join(' ')).toContain(
        'must not hold more than 200 products',
      );
      expect(await memberIds(created.id)).toEqual(idsOf('Alpha'));
    });

    it.each([
      [{}, 'productIds must be an array'],
      [{ productIds: 'abc' }, 'productIds must be an array'],
      [{ productIds: [1, 'two'] }, 'every product id must be a whole number'],
      [{ productIds: [0] }, 'every product id must be 1 or more'],
    ])('rejects the body %j', async (body, message) => {
      const created = await createCollection({
        name: `Bad body ${message.length}`,
      });

      const res = await asAdmin(
        http().put(`/admin/collections/${created.id}/products`),
      )
        .send(body)
        .expect(400);

      expect((res.body.message as string[]).join(' ')).toContain(message);
    });

    it('answers 404 for an unknown collection', async () => {
      await asAdmin(http().put('/admin/collections/999999/products'))
        .send({ productIds: [idOf('Alpha')] })
        .expect(404);
    });

    it('is all or nothing: a failure while saving leaves the old membership intact', async () => {
      const created = await createCollection({ name: 'Atomic' });
      await setProducts(created.id, ['Alpha', 'Bravo']);
      // A trigger makes the insert of one particular product fail after the old
      // rows were deleted, the way an unexpected database error would.
      const poisoned = idOf('Golf');
      await dataSource.query(`
        CREATE FUNCTION fail_for_poisoned_product() RETURNS trigger AS $$
        BEGIN
          IF NEW."productId" = ${poisoned} THEN
            RAISE EXCEPTION 'insert refused for the test';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await dataSource.query(`
        CREATE TRIGGER fail_for_poisoned_product BEFORE INSERT ON collection_products
        FOR EACH ROW EXECUTE FUNCTION fail_for_poisoned_product()
      `);

      try {
        await asAdmin(http().put(`/admin/collections/${created.id}/products`))
          .send({ productIds: idsOf('Charlie', 'Golf', 'Delta') })
          .expect(500);

        expect(await memberIds(created.id)).toEqual(idsOf('Alpha', 'Bravo'));
        const detail = await asAdmin(
          http().get(`/admin/collections/${created.id}`),
        ).expect(200);
        expect(
          (detail.body.products as MemberBody[]).map((item) => item.name),
        ).toEqual(['Alpha', 'Bravo']);
      } finally {
        await dataSource.query(
          `DROP TRIGGER fail_for_poisoned_product ON collection_products`,
        );
        await dataSource.query(`DROP FUNCTION fail_for_poisoned_product()`);
      }

      // And the same request works once the cause is gone.
      await setProducts(created.id, ['Charlie', 'Golf', 'Delta']);
      expect(await memberIds(created.id)).toEqual(
        idsOf('Charlie', 'Golf', 'Delta'),
      );
    });

    it('two replacements at once never mix: the result is one of the two lists', async () => {
      const created = await createCollection({ name: 'Race' });
      const first = idsOf('Alpha', 'Bravo', 'Charlie');
      const second = idsOf('Echo', 'Foxtrot');

      await Promise.all([
        asAdmin(http().put(`/admin/collections/${created.id}/products`)).send({
          productIds: first,
        }),
        asAdmin(http().put(`/admin/collections/${created.id}/products`)).send({
          productIds: second,
        }),
      ]);

      const result = await memberIds(created.id);
      expect([first, second]).toContainEqual(result);
    });
  });

  describe('public: GET /collections', () => {
    // Four collections: two shown, one inactive, one empty, one holding only
    // products nobody can buy (inactive product, no active variant, no variant).
    async function seedCollections() {
      const second = await createCollection({
        name: 'Second',
        sortOrder: 2,
        isFeatured: true,
        description: 'The second one.',
        heroImageUrl: 'https://res.cloudinary.com/demo/image/upload/s.jpg',
      });
      const first = await createCollection({ name: 'First', sortOrder: 1 });
      const tied = await createCollection({ name: 'Tied', sortOrder: 2 });
      const inactive = await createCollection({
        name: 'Inactive',
        isActive: false,
        sortOrder: 0,
      });
      await createCollection({ name: 'Empty', sortOrder: 0 });
      const unbuyable = await createCollection({
        name: 'Unbuyable',
        sortOrder: 0,
      });

      await setProducts(second.id, [
        'Alpha',
        'Bravo',
        'Hotel',
        'India',
        'Juliet',
      ]);
      await setProducts(first.id, ['Charlie']);
      await setProducts(tied.id, ['Delta', 'Echo']);
      await setProducts(inactive.id, ['Foxtrot']);
      await setProducts(unbuyable.id, ['Hotel', 'India', 'Juliet']);
      return { first, second, tied };
    }

    it('lists only active collections with a visible product, by sortOrder then id, with the visible count', async () => {
      await seedCollections();

      const res = await http().get('/collections').expect(200);

      // "Second" was created before "Tied": equal sortOrder 2 falls back to id.
      expect(publicNames(res.body)).toEqual(['First', 'Second', 'Tied']);
      expect(
        (res.body as CollectionBody[]).map((item) => item.productCount),
      ).toEqual([1, 2, 2]);
      expect(res.headers['x-total-count']).toBeUndefined();
    });

    it('returns exactly the public fields, and no admin-only ones', async () => {
      await seedCollections();

      const res = await http().get('/collections').expect(200);
      const second = (res.body as CollectionBody[]).find(
        (item) => item.name === 'Second',
      )!;

      expect(Object.keys(second).sort()).toEqual([
        'description',
        'heroImageUrl',
        'id',
        'isFeatured',
        'name',
        'productCount',
        'slug',
      ]);
      expect(second).toMatchObject({
        slug: 'second',
        description: 'The second one.',
        heroImageUrl: 'https://res.cloudinary.com/demo/image/upload/s.jpg',
        isFeatured: true,
        productCount: 2,
      });
    });

    it('needs no token', async () => {
      await seedCollections();

      await http().get('/collections').expect(200);
    });

    it('pages on request with the standard headers, and is unchanged without a page', async () => {
      await seedCollections();

      const pageOne = await http()
        .get('/collections?page=1&limit=2')
        .expect(200);
      expect(publicNames(pageOne.body)).toEqual(['First', 'Second']);
      expect(pageOne.headers['x-total-count']).toBe('3');
      expect(pageOne.headers['x-total-pages']).toBe('2');
      expect(pageOne.headers['x-page']).toBe('1');
      expect(pageOne.headers['x-limit']).toBe('2');

      const pageTwo = await http()
        .get('/collections?page=2&limit=2')
        .expect(200);
      expect(publicNames(pageTwo.body)).toEqual(['Tied']);

      const beyond = await http()
        .get('/collections?page=3&limit=2')
        .expect(200);
      expect(beyond.body).toEqual([]);
      expect(beyond.headers['x-total-count']).toBe('3');

      const onlyLimit = await http().get('/collections?limit=1').expect(200);
      expect(publicNames(onlyLimit.body)).toEqual(['First']);
      expect(onlyLimit.headers['x-page']).toBe('1');
      await http().get('/collections?limit=101').expect(400);
      await http().get('/collections?page=0').expect(400);
    });

    it('is empty, with zero totals, when nothing qualifies', async () => {
      const res = await http().get('/collections?page=1').expect(200);

      expect(res.body).toEqual([]);
      expect(res.headers['x-total-count']).toBe('0');
      expect(res.headers['x-total-pages']).toBe('0');
    });

    it('follows the admin: toggling a collection off hides it, an inactive product lowers the count', async () => {
      const { first, tied } = await seedCollections();
      await asAdmin(
        http().patch(`/admin/collections/${first.id}/toggle`),
      ).expect(200);
      await dataSource
        .getRepository(Product)
        .update({ id: idOf('Echo') }, { status: ProductStatus.INACTIVE });

      try {
        const res = await http().get('/collections').expect(200);

        expect(publicNames(res.body)).toEqual(['Second', 'Tied']);
        expect(
          (res.body as CollectionBody[]).find((item) => item.id === tied.id)
            ?.productCount,
        ).toBe(1);
      } finally {
        await dataSource
          .getRepository(Product)
          .update({ id: idOf('Echo') }, { status: ProductStatus.ACTIVE });
      }
    });
  });

  describe('public: GET /collections/:slug', () => {
    it('returns the collection with its visible product count', async () => {
      const created = await createCollection({
        name: 'Everyday Essentials',
        description: 'Simple pieces.',
        isFeatured: true,
      });
      await setProducts(created.id, ['Alpha', 'Hotel', 'Bravo']);

      const res = await http()
        .get('/collections/everyday-essentials')
        .expect(200);

      expect(res.body).toEqual({
        id: created.id,
        slug: 'everyday-essentials',
        name: 'Everyday Essentials',
        description: 'Simple pieces.',
        heroImageUrl: null,
        isFeatured: true,
        productCount: 2,
      });
    });

    it('answers 404 for an unknown slug', async () => {
      const res = await http()
        .get('/collections/no-such-collection')
        .expect(404);

      expect(res.body.message).toBe('Collection not found');
    });

    it('answers 404 for an inactive collection', async () => {
      const created = await createCollection({
        name: 'Switched Off',
        isActive: false,
      });
      await setProducts(created.id, ['Alpha']);

      await http().get('/collections/switched-off').expect(404);
    });

    it('answers 404 for an empty collection', async () => {
      await createCollection({ name: 'Nothing In It' });

      await http().get('/collections/nothing-in-it').expect(404);
    });

    it('answers 404 when no product in it is visible', async () => {
      const created = await createCollection({ name: 'Unbuyable Only' });
      // Inactive product, product with no active variant, product with no variant.
      await setProducts(created.id, ['Hotel', 'India', 'Juliet']);

      await http().get('/collections/unbuyable-only').expect(404);
    });

    it('becomes visible once one visible product is added', async () => {
      const created = await createCollection({ name: 'Becomes Visible' });
      await setProducts(created.id, ['Hotel']);
      await http().get('/collections/becomes-visible').expect(404);

      await setProducts(created.id, ['Hotel', 'Alpha']);

      await http().get('/collections/becomes-visible').expect(200);
    });
  });

  describe('public: GET /products?collection=', () => {
    async function seedOrdered() {
      const created = await createCollection({ name: 'Ordered Set' });
      // Display order is neither alphabetical, nor by price, nor by id.
      await setProducts(created.id, [
        'Echo',
        'Bravo',
        'Golf',
        'Alpha',
        'Delta',
        'Hotel',
        'India',
        'Juliet',
      ]);
      return created;
    }

    it("lists the collection's visible products in the collection's own order by default", async () => {
      await seedOrdered();

      const res = await http()
        .get('/products?collection=ordered-set')
        .expect(200);

      // Hotel (inactive), India (no active variant) and Juliet (no variant) are out.
      expect(publicNames(res.body)).toEqual([
        'Echo',
        'Bravo',
        'Golf',
        'Alpha',
        'Delta',
      ]);
      expect(res.headers['x-total-count']).toBeUndefined();
    });

    it('pages in that order, with headers, without overlap or gaps', async () => {
      await seedOrdered();

      const one = await http()
        .get('/products?collection=ordered-set&page=1&limit=2')
        .expect(200);
      const two = await http()
        .get('/products?collection=ordered-set&page=2&limit=2')
        .expect(200);
      const three = await http()
        .get('/products?collection=ordered-set&page=3&limit=2')
        .expect(200);

      expect(publicNames(one.body)).toEqual(['Echo', 'Bravo']);
      expect(publicNames(two.body)).toEqual(['Golf', 'Alpha']);
      expect(publicNames(three.body)).toEqual(['Delta']);
      expect(one.headers['x-total-count']).toBe('5');
      expect(one.headers['x-total-pages']).toBe('3');
      expect(two.headers['x-page']).toBe('2');
      expect(two.headers['x-limit']).toBe('2');
      const beyond = await http()
        .get('/products?collection=ordered-set&page=4&limit=2')
        .expect(200);
      expect(beyond.body).toEqual([]);
      expect(beyond.headers['x-total-count']).toBe('5');
    });

    it('honours an explicit sort instead of the collection order', async () => {
      await seedOrdered();

      const byName = await http()
        .get('/products?collection=ordered-set&sort=name_asc')
        .expect(200);
      expect(publicNames(byName.body)).toEqual([
        'Alpha',
        'Bravo',
        'Delta',
        'Echo',
        'Golf',
      ]);

      const byPrice = await http()
        .get('/products?collection=ordered-set&sort=price_asc')
        .expect(200);
      expect(publicNames(byPrice.body)).toEqual([
        'Bravo',
        'Delta',
        'Golf',
        'Echo',
        'Alpha',
      ]);

      // Even "featured" is an explicit sort: name order, not collection order.
      const featured = await http()
        .get('/products?collection=ordered-set&sort=featured')
        .expect(200);
      expect(publicNames(featured.body)).toEqual([
        'Alpha',
        'Bravo',
        'Delta',
        'Echo',
        'Golf',
      ]);

      const paged = await http()
        .get('/products?collection=ordered-set&sort=price_desc&page=2&limit=2')
        .expect(200);
      expect(publicNames(paged.body)).toEqual(['Golf', 'Delta']);
      expect(paged.headers['x-total-count']).toBe('5');
    });

    it('combines with the other filters', async () => {
      await seedOrdered();

      const cheap = await http()
        .get('/products?collection=ordered-set&maxPrice=250000')
        .expect(200);
      expect(publicNames(cheap.body)).toEqual(['Bravo', 'Golf', 'Delta']);

      const search = await http()
        .get('/products?collection=ordered-set&q=lph&page=1')
        .expect(200);
      expect(publicNames(search.body)).toEqual(['Alpha']);
      expect(search.headers['x-total-count']).toBe('1');

      const category = await http()
        .get('/products?collection=ordered-set&category=category-collections')
        .expect(200);
      expect(category.body).toHaveLength(5);
    });

    it('uses the position of the collection asked for when a product is in two', async () => {
      const first = await createCollection({ name: 'First Set' });
      const second = await createCollection({ name: 'Second Set' });
      await setProducts(first.id, ['Alpha', 'Bravo', 'Charlie']);
      await setProducts(second.id, ['Charlie', 'Bravo', 'Alpha']);

      const a = await http().get('/products?collection=first-set').expect(200);
      const b = await http().get('/products?collection=second-set').expect(200);

      expect(publicNames(a.body)).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(publicNames(b.body)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    });

    it('answers an empty list, with the normal headers, for an unknown slug', async () => {
      const plain = await http().get('/products?collection=nope').expect(200);
      expect(plain.body).toEqual([]);

      const paged = await http()
        .get('/products?collection=nope&page=1')
        .expect(200);
      expect(paged.body).toEqual([]);
      expect(paged.headers['x-total-count']).toBe('0');
      expect(paged.headers['x-total-pages']).toBe('0');
      expect(paged.headers['x-page']).toBe('1');
      expect(paged.headers['x-limit']).toBe('12');
    });

    it('answers an empty list for an inactive collection', async () => {
      const created = await createCollection({
        name: 'Off Set',
        isActive: false,
      });
      await setProducts(created.id, ['Alpha', 'Bravo']);

      const res = await http()
        .get('/products?collection=off-set&page=1')
        .expect(200);

      expect(res.body).toEqual([]);
      expect(res.headers['x-total-count']).toBe('0');
    });

    it('does not change /products without the filter', async () => {
      await seedOrdered();

      const res = await http().get('/products').expect(200);

      // Every active product, in name order (also those without a variant).
      expect(publicNames(res.body)).toEqual([
        'Alpha',
        'Bravo',
        'Charlie',
        'Delta',
        'Echo',
        'Foxtrot',
        'Golf',
        'India',
        'Juliet',
      ]);
    });

    it('leaves /products/filters as it was', async () => {
      const before = await http().get('/products/filters').expect(200);
      await seedOrdered();

      const after = await http().get('/products/filters').expect(200);

      expect(after.body).toEqual(before.body);
    });

    it('rejects a collection value that is too long', async () => {
      await http()
        .get(`/products?collection=${'a'.repeat(256)}`)
        .expect(400);
    });
  });
});
