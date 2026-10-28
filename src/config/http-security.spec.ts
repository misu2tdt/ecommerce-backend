import { Controller, Get, Req } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { configureSwagger } from '../docs/swagger';
import { configureHttpSecurity } from './http-security';

@Controller()
class ProbeController {
  @Get('probe')
  probe(@Req() req: Request) {
    return { ip: req.ip };
  }
}

const frontendOrigin = 'https://shop.example.test';

async function createApp(
  nodeEnvironment: 'development' | 'test' | 'production',
  options: { swagger?: boolean } = {},
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttpSecurity(app, { nodeEnvironment, frontendOrigin });
  if (options.swagger) configureSwagger(app);
  await app.init();
  return app;
}

describe('configureHttpSecurity', () => {
  describe('trust proxy', () => {
    it('uses the client IP added by the single trusted proxy in production', async () => {
      const app = await createApp('production');
      try {
        const res = await request(app.getHttpServer())
          .get('/probe')
          .set('X-Forwarded-For', '203.0.113.7')
          .expect(200);
        expect((res.body as { ip: string }).ip).toBe('203.0.113.7');
      } finally {
        await app.close();
      }
    });

    it('ignores client-supplied forwarding hops beyond the one trusted proxy', async () => {
      const app = await createApp('production');
      try {
        const res = await request(app.getHttpServer())
          .get('/probe')
          .set('X-Forwarded-For', '1.2.3.4, 203.0.113.7')
          .expect(200);
        expect((res.body as { ip: string }).ip).toBe('203.0.113.7');
      } finally {
        await app.close();
      }
    });

    it('does not trust X-Forwarded-For outside production', async () => {
      const app = await createApp('development');
      try {
        const res = await request(app.getHttpServer())
          .get('/probe')
          .set('X-Forwarded-For', '203.0.113.7')
          .expect(200);
        expect((res.body as { ip: string }).ip).not.toBe('203.0.113.7');
      } finally {
        await app.close();
      }
    });
  });

  describe('helmet', () => {
    it('sets baseline security headers and hides X-Powered-By', async () => {
      const app = await createApp('production');
      try {
        const res = await request(app.getHttpServer())
          .get('/probe')
          .expect(200);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-powered-by']).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('keeps Swagger UI loadable under the default CSP', async () => {
      const app = await createApp('development', { swagger: true });
      try {
        const page = await request(app.getHttpServer())
          .get('/api/docs')
          .expect(200);
        expect(page.headers['content-security-policy']).toContain(
          "script-src 'self'",
        );
        // The default CSP forbids inline scripts, so the UI must only load
        // external ones.
        expect(page.text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
        await request(app.getHttpServer())
          .get('/api/docs/swagger-ui-init.js')
          .expect(200);
        await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('CORS', () => {
    it('still allows the configured frontend origin next to helmet headers', async () => {
      const app = await createApp('production');
      try {
        const preflight = await request(app.getHttpServer())
          .options('/probe')
          .set('Origin', frontendOrigin)
          .set('Access-Control-Request-Method', 'GET');
        expect(preflight.headers['access-control-allow-origin']).toBe(
          frontendOrigin,
        );

        const res = await request(app.getHttpServer())
          .get('/probe')
          .set('Origin', frontendOrigin)
          .expect(200);
        expect(res.headers['access-control-allow-origin']).toBe(frontendOrigin);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      } finally {
        await app.close();
      }
    });

    it('does not allow other origins', async () => {
      const app = await createApp('production');
      try {
        const res = await request(app.getHttpServer())
          .get('/probe')
          .set('Origin', 'https://evil.example.test')
          .expect(200);
        expect(res.headers['access-control-allow-origin']).not.toBe(
          'https://evil.example.test',
        );
      } finally {
        await app.close();
      }
    });
  });
});
