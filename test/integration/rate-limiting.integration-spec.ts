import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AUTH_THROTTLE, GLOBAL_THROTTLE } from '../../src/config/throttling';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Rate limiting', () => {
  let app: INestApplication;
  let dataSource: DataSource;

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

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  async function statuses(
    count: number,
    send: () => request.Test,
  ): Promise<number[]> {
    const results: number[] = [];
    for (let index = 0; index < count; index += 1) {
      results.push((await send()).status);
    }
    return results;
  }

  it('applies a generous global default per IP', async () => {
    const results = await statuses(GLOBAL_THROTTLE.limit + 1, () =>
      request(app.getHttpServer()).get('/'),
    );

    expect(results.slice(0, GLOBAL_THROTTLE.limit)).not.toContain(429);
    expect(results[GLOBAL_THROTTLE.limit]).toBe(429);
  });

  it('limits POST /auth/login strictly', async () => {
    const results = await statuses(AUTH_THROTTLE.limit + 1, () =>
      request(app.getHttpServer()).post('/auth/login').send({}),
    );

    expect(results.slice(0, AUTH_THROTTLE.limit)).not.toContain(429);
    expect(results[AUTH_THROTTLE.limit]).toBe(429);
  });

  it('limits POST /users/register strictly', async () => {
    const results = await statuses(AUTH_THROTTLE.limit + 1, () =>
      request(app.getHttpServer()).post('/users/register').send({}),
    );

    expect(results.slice(0, AUTH_THROTTLE.limit)).not.toContain(429);
    expect(results[AUTH_THROTTLE.limit]).toBe(429);
  });

  it('never throttles the MoMo IPN webhook', async () => {
    const results = await statuses(GLOBAL_THROTTLE.limit + 20, () =>
      request(app.getHttpServer()).post('/payments/webhooks/momo').send({}),
    );

    expect(results).not.toContain(429);
  });

  it('never throttles GET /health', async () => {
    const results = await statuses(GLOBAL_THROTTLE.limit + 20, () =>
      request(app.getHttpServer()).get('/health'),
    );

    expect(results).not.toContain(429);
    expect(new Set(results)).toEqual(new Set([200]));
  });
});
