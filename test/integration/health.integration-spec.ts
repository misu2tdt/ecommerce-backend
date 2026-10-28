import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('GET /health PostgreSQL Integration', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('answers 200 when the database responds', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers 503 when the database does not respond', async () => {
    jest
      .spyOn(app.get(DataSource), 'query')
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const res = await request(app.getHttpServer()).get('/health').expect(503);

    expect(res.body).toEqual({ status: 'unavailable' });
    expect(res.text).not.toContain('ECONNREFUSED');
  });
});
