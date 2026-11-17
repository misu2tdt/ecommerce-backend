import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { Product } from '../../src/products/entities/product.entity';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { User } from '../../src/users/entities/user.entity';
import { createCategory } from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Reviews of a product that is not on sale (PostgreSQL, full HTTP stack)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  let activeId: number;
  let hiddenId: number;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'reviewer@hidden-reviews.test',
      password: 'hash',
      role: UserRole.USER,
    });
    token = await app
      .get(JwtService)
      .signAsync({ sub: user.id, email: user.email, role: user.role });
    const category = await createCategory(dataSource, 'hidden-reviews');
    const products = dataSource.getRepository(Product);
    const make = (slug: string, status: ProductStatus) =>
      products.save({
        name: slug,
        slug,
        description: null,
        status,
        categoryId: category.id,
        brandId: null,
      });
    activeId = (await make('on-sale', ProductStatus.ACTIVE)).id;
    hiddenId = (await make('not-on-sale', ProductStatus.INACTIVE)).id;
    // A visible review on each product, written straight to the table.
    for (const productId of [activeId, hiddenId]) {
      await dataSource.query(
        `INSERT INTO "product_reviews" ("userId", "productId", "rating", "title", "isVisible")
         VALUES ($1, $2, 5, 'Great', true)`,
        [user.id, productId],
      );
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  it('lists the visible reviews of a product on sale (unchanged)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/products/${activeId}/reviews`)
      .expect(200);

    expect(response.body).toHaveLength(1);
  });

  it('answers 404, like an unknown id, for the reviews of an inactive product', async () => {
    const hidden = await request(app.getHttpServer())
      .get(`/products/${hiddenId}/reviews`)
      .expect(404);
    const unknown = await request(app.getHttpServer())
      .get('/products/987654/reviews')
      .expect(404);

    expect(hidden.body).toEqual(unknown.body);
  });

  it('accepts no new review for an inactive product, with the same 404', async () => {
    await request(app.getHttpServer())
      .post(`/products/${hiddenId}/reviews`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rating: 4 })
      .expect(404);

    const [{ count }] = await dataSource.query<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM "product_reviews" WHERE "productId" = $1`,
      [hiddenId],
    );
    expect(count).toBe(1);
  });

  it('still lets a reviewer read their own review of it', async () => {
    await request(app.getHttpServer())
      .get(`/products/${hiddenId}/reviews/mine`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
