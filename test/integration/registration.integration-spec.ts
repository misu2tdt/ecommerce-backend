import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

const PASSWORD = 'long-enough-1';

describe('Registration and login emails (PostgreSQL, full HTTP stack)', () => {
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

  beforeEach(async () => {
    await cleanTestDatabase(dataSource);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  const register = (email: string, password = PASSWORD) =>
    request(app.getHttpServer())
      .post('/users/register')
      .send({ email, password });
  const login = (email: string, password = PASSWORD) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password });
  const rowsFor = (email: string) =>
    dataSource.query<Array<{ id: number; email: string }>>(
      `SELECT "id", "email" FROM "users" WHERE LOWER("email") = $1 ORDER BY "id"`,
      [email.toLowerCase()],
    );
  const subjectOf = (token: string) =>
    app.get(JwtService).decode<{ sub: number }>(token).sub;

  describe('two registrations at the same moment', () => {
    it.each([
      ['the same email', 'race-same@example.test', 'race-same@example.test'],
      [
        'emails that differ by case',
        'Race-Case@example.test',
        'race-case@EXAMPLE.test',
      ],
      [
        'emails that differ by spaces',
        ' race-space@example.test',
        'race-space@example.test ',
      ],
    ])(
      '%s: one 201 and one 409, never a 500, and one account',
      async (_label, first, second) => {
        const [one, two] = await Promise.all([
          register(first),
          register(second),
        ]);

        expect([one.status, two.status].sort()).toEqual([201, 409]);
        const refused = one.status === 409 ? one : two;
        expect(refused.body).toMatchObject({
          statusCode: 409,
          message: 'This email is already registered.',
        });
        expect(await rowsFor(first.trim())).toHaveLength(1);
      },
    );
  });

  describe('one account whatever the case', () => {
    it('stores and returns the email in lowercase', async () => {
      const response = await register('  Mixed.Case@Example.TEST ').expect(201);

      expect(response.body).toMatchObject({ email: 'mixed.case@example.test' });
      expect((await rowsFor('mixed.case@example.test'))[0].email).toBe(
        'mixed.case@example.test',
      );
    });

    it('answers 409 for the same address in another case, afterwards too', async () => {
      await register('afterwards@example.test').expect(201);

      await register('AFTERWARDS@example.test').expect(409);
      await register(' Afterwards@Example.Test ').expect(409);
    });

    it('lets the account sign in with any case of its email', async () => {
      await register('Sign.In@example.test').expect(201);

      for (const email of [
        'sign.in@example.test',
        'SIGN.IN@EXAMPLE.TEST',
        '  Sign.In@example.test  ',
      ]) {
        const response = await login(email).expect(200);
        expect(response.body).toHaveProperty('access_token');
      }
      await login('sign.in@example.test', 'wrong-password-1').expect(401);
    });
  });

  describe('accounts stored before emails were normalised', () => {
    const hash = (password: string) => bcrypt.hash(password, 4);
    const insert = async (email: string, password: string) => {
      const rows = await dataSource.query<Array<{ id: number }>>(
        `INSERT INTO "users" ("email", "password", "role") VALUES ($1, $2, 'user') RETURNING "id"`,
        [email, await hash(password)],
      );
      return rows[0].id;
    };

    it('finds an account stored with capital letters, for sign-in and for the 409', async () => {
      const id = await insert('Legacy@Example.test', PASSWORD);

      await register('legacy@example.test').expect(409);
      const response = await login('legacy@example.test').expect(200);
      expect(
        subjectOf((response.body as { access_token: string }).access_token),
      ).toBe(id);
    });

    it('keeps two accounts that differ only by case usable, each with its own password', async () => {
      const first = await insert('Both@Example.test', 'password-of-first-1');
      const second = await insert('both@example.test', 'password-of-second-1');

      const one = await login(
        'both@example.test',
        'password-of-first-1',
      ).expect(200);
      const two = await login(
        'both@example.test',
        'password-of-second-1',
      ).expect(200);

      expect(
        subjectOf((one.body as { access_token: string }).access_token),
      ).toBe(first);
      expect(
        subjectOf((two.body as { access_token: string }).access_token),
      ).toBe(second);
      await login('both@example.test', 'password-of-nobody-1').expect(401);
    });
  });

  describe('the reserved seed domain', () => {
    it.each([
      'anyone@demo-history.example.com',
      'Anyone@Demo-History.Example.COM',
      '  anyone@demo-history.example.com ',
    ])('answers 400 for %s and creates no account', async (email) => {
      const response = await register(email).expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        message: 'This email domain is reserved.',
      });
      expect(await rowsFor(email.trim())).toHaveLength(0);
    });

    it('does not touch other domains', async () => {
      await register('anyone@example.com').expect(201);
    });
  });
});
