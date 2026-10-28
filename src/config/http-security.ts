import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { RuntimeEnvironment } from './environment';

export function configureHttpSecurity(
  app: NestExpressApplication,
  runtime: Pick<RuntimeEnvironment, 'nodeEnvironment' | 'frontendOrigin'>,
): void {
  if (runtime.nodeEnvironment === 'production') {
    // In production the app runs behind Render's proxy, so the socket address
    // is the proxy's, not the client's. Trust exactly one hop so `req.ip` is
    // the real client IP (the throttler counts requests per IP). A larger
    // value or `true` would let clients spoof X-Forwarded-For.
    app.set('trust proxy', 1);
  }

  app.use(helmet());

  if (runtime.frontendOrigin) {
    app.enableCors({ origin: runtime.frontendOrigin });
  }
}
