import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import {
  ANONYMOUS_THROTTLE,
  LOGIN_EMAIL_THROTTLE,
  LOGIN_IP_THROTTLE,
  ME_THROTTLE,
  REGISTER_THROTTLE,
  USER_THROTTLE,
} from '../../src/config/throttling';
import { configureHttpSecurity } from '../../src/config/http-security';
import { UserRole } from '../../src/users/entities/user-role.enum';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

// Buckets are kept per route handler and per caller: a signed-in user, a login
// email, or a client IP. The app runs as it does in production (one trusted
// proxy hop), so each request names its client IP in X-Forwarded-For. Every test
// uses IPs, emails and user ids of its own, so no test shares a bucket.
describe('Rate limiting', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwt: JwtService;
  let nextHost = 1;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const expressApp =
      moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpSecurity(expressApp, {
      nodeEnvironment: 'production',
      frontendOrigin: undefined,
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
    jwt = app.get(JwtService);
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

  // A client IP no other test uses.
  function freshIp(): string {
    nextHost += 1;
    return `198.51.100.${nextHost}`;
  }

  function tokenFor(userId: number): string {
    return jwt.sign({
      sub: userId,
      email: `user${userId}@example.test`,
      role: UserRole.USER,
    });
  }

  interface Caller {
    ip: string;
    token?: string;
  }

  function send(
    method: 'get' | 'post',
    path: string,
    caller: Caller,
    body?: object,
  ): request.Test {
    const call = request(app.getHttpServer())[method](path);
    call.set('X-Forwarded-For', caller.ip);
    if (caller.token) call.set('Authorization', `Bearer ${caller.token}`);
    return body ? call.send(body) : call;
  }

  async function statuses(
    count: number,
    send: (index: number) => request.Test,
  ): Promise<number[]> {
    const results: number[] = [];
    for (let index = 0; index < count; index += 1) {
      results.push((await send(index)).status);
    }
    return results;
  }

  // The first `limit` requests pass and the next one is refused.
  function expectLimitedAfter(results: number[], limit: number) {
    expect(results.slice(0, limit)).not.toContain(429);
    expect(results[limit]).toBe(429);
  }

  const status = async (promise: request.Test) => (await promise).status;

  describe('anonymous visitors', () => {
    it('are limited per IP, with room for a proxy that many visitors share', async () => {
      const ip = freshIp();
      const results = await statuses(ANONYMOUS_THROTTLE.limit + 1, () =>
        send('get', '/', { ip }),
      );

      expectLimitedAfter(results, ANONYMOUS_THROTTLE.limit);
      // 100 a minute for a whole shared IP was the old, too small, ceiling.
      expect(ANONYMOUS_THROTTLE.limit).toBeGreaterThan(100);

      // Another client IP is unaffected.
      expect(await status(send('get', '/', { ip: freshIp() }))).toBe(200);
      // Someone signed in behind the same IP has a bucket of their own.
      expect(await status(send('get', '/', { ip, token: tokenFor(900) }))).toBe(
        200,
      );
    });

    it('cannot leave the IP bucket with a forged, expired or foreign token', async () => {
      const ip = freshIp();
      await statuses(ANONYMOUS_THROTTLE.limit + 1, () =>
        send('get', '/', { ip }),
      );

      const forged = new JwtService({ secret: 'not-the-api-secret' }).sign({
        sub: 901,
        email: 'user901@example.test',
        role: UserRole.USER,
      });
      const expired = jwt.sign(
        { sub: 902, email: 'user902@example.test', role: UserRole.USER },
        { expiresIn: '-10s' },
      );
      const tampered = `${tokenFor(903).slice(0, -3)}abc`;

      for (const token of [forged, expired, tampered, 'garbage']) {
        expect(await status(send('get', '/', { ip, token }))).toBe(429);
      }
    });

    it('cannot pick another IP by sending their own forwarding chain', async () => {
      const ip = freshIp();
      await statuses(ANONYMOUS_THROTTLE.limit + 1, () =>
        send('get', '/', { ip }),
      );

      // Render appends the address it saw; a client can only add hops before it.
      const spoofed = request(app.getHttpServer())
        .get('/')
        .set('X-Forwarded-For', `10.9.8.7, ${ip}`);

      expect(await status(spoofed)).toBe(429);
    });
  });

  describe('signed-in users', () => {
    it('each get a bucket of their own, even behind one shared IP', async () => {
      const ip = freshIp();
      const alice = { ip, token: tokenFor(1001) };
      const bob = { ip, token: tokenFor(1002) };

      const results = await statuses(USER_THROTTLE.limit + 1, () =>
        send('get', '/', alice),
      );

      expectLimitedAfter(results, USER_THROTTLE.limit);
      expect(await status(send('get', '/', bob))).toBe(200);
      expect(await status(send('get', '/', { ip }))).toBe(200);
    });

    it('allow more in a minute than the bucket one shared IP gets from a single person', () => {
      expect(USER_THROTTLE.limit).toBeGreaterThan(100);
      expect(USER_THROTTLE.limit).toBeLessThan(ANONYMOUS_THROTTLE.limit);
    });
  });

  describe('GET /auth/me', () => {
    it('lets the header ask on every page, and exhausting it starves nothing else', async () => {
      const ip = freshIp();
      const shopper = { ip, token: tokenFor(2001) };

      const results = await statuses(ME_THROTTLE.limit + 1, () =>
        send('get', '/auth/me', shopper),
      );

      expectLimitedAfter(results, ME_THROTTLE.limit);
      // Same user, same IP, other routes: still served.
      expect(await status(send('get', '/', shopper))).toBe(200);
      expect(await status(send('get', '/health', shopper))).toBe(200);
      // Other users, and visitors with no session, behind the same IP.
      expect(
        await status(send('get', '/auth/me', { ip, token: tokenFor(2002) })),
      ).toBe(200);
      expect(await status(send('get', '/auth/me', { ip }))).toBe(401);
    });
  });

  describe('POST /auth/login', () => {
    const attempt = (caller: Caller, email: string) =>
      send('post', '/auth/login', caller, {
        email,
        password: 'wrong-password',
      });

    it('does not let different emails from one IP block each other', async () => {
      const ip = freshIp();

      const results = await statuses(LOGIN_EMAIL_THROTTLE.limit + 1, () =>
        attempt({ ip }, 'first.shopper@example.test'),
      );

      expectLimitedAfter(results, LOGIN_EMAIL_THROTTLE.limit);
      expect(results[0]).toBe(401);
      // Someone else on the same IP can still sign in (or fail normally).
      expect(await status(attempt({ ip }, 'second.shopper@example.test'))).toBe(
        401,
      );
    });

    it('limits one email across many IPs, whatever its spelling', async () => {
      const spellings = [
        'victim@example.test',
        'Victim@Example.test',
        ' VICTIM@EXAMPLE.TEST ',
      ];

      const results = await statuses(LOGIN_EMAIL_THROTTLE.limit + 1, (index) =>
        attempt({ ip: freshIp() }, spellings[index % spellings.length]),
      );

      expectLimitedAfter(results, LOGIN_EMAIL_THROTTLE.limit);
      // The tenth IP is blocked for this email only.
      const newcomer = freshIp();
      expect(
        await status(attempt({ ip: newcomer }, 'victim@example.test')),
      ).toBe(429);
      expect(
        await status(attempt({ ip: newcomer }, 'bystander@example.test')),
      ).toBe(401);
    });

    it('keeps an IP ceiling that a shared proxy will not reach by accident', async () => {
      const ip = freshIp();

      const results = await statuses(LOGIN_IP_THROTTLE.limit + 1, (index) =>
        attempt({ ip }, `shopper${index}@example.test`),
      );

      expectLimitedAfter(results, LOGIN_IP_THROTTLE.limit);
      expect(LOGIN_IP_THROTTLE.limit).toBeGreaterThan(
        LOGIN_EMAIL_THROTTLE.limit,
      );
      expect(
        await status(attempt({ ip: freshIp() }, 'shopper0@example.test')),
      ).toBe(401);
    });

    it('applies the IP ceiling even to a request that carries a valid token', async () => {
      const ip = freshIp();
      await statuses(LOGIN_IP_THROTTLE.limit + 1, (index) =>
        attempt({ ip }, `ceiling${index}@example.test`),
      );

      expect(
        await status(
          attempt({ ip, token: tokenFor(3001) }, 'ceiling-token@example.test'),
        ),
      ).toBe(429);
    });

    it('falls back to the IP when a request has no usable email', async () => {
      const ip = freshIp();

      const results = await statuses(LOGIN_EMAIL_THROTTLE.limit + 1, () =>
        send('post', '/auth/login', { ip }, {}),
      );

      expectLimitedAfter(results, LOGIN_EMAIL_THROTTLE.limit);
      expect(
        await status(send('post', '/auth/login', { ip: freshIp() }, {})),
      ).toBe(400);
    });
  });

  describe('POST /users/register', () => {
    it('is limited per IP, whoever is signed in', async () => {
      const ip = freshIp();

      const results = await statuses(REGISTER_THROTTLE.limit + 1, (index) =>
        send(
          'post',
          '/users/register',
          { ip, token: tokenFor(4000 + index) },
          {},
        ),
      );

      expectLimitedAfter(results, REGISTER_THROTTLE.limit);
      expect(
        await status(send('post', '/users/register', { ip: freshIp() }, {})),
      ).toBe(400);
    });
  });

  describe('exemptions', () => {
    it('never throttles the MoMo IPN webhook', async () => {
      const ip = freshIp();
      const results = await statuses(ANONYMOUS_THROTTLE.limit + 20, () =>
        send('post', '/payments/webhooks/momo', { ip }, {}),
      );

      expect(results).not.toContain(429);
    });

    it('never throttles GET /health', async () => {
      const ip = freshIp();
      const results = await statuses(ANONYMOUS_THROTTLE.limit + 20, () =>
        send('get', '/health', { ip }),
      );

      expect(results).not.toContain(429);
      expect(new Set(results)).toEqual(new Set([200]));
    });
  });

  describe('hardening that stays in place', () => {
    it('keeps helmet headers and hides the framework', async () => {
      const response = await send('get', '/', { ip: freshIp() });

      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
    });
  });
});
