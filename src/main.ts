import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validateRuntimeEnvironment } from './config/environment';
import { configureHttpSecurity } from './config/http-security';
import { configureSwagger } from './docs/swagger';

async function bootstrap() {
  const runtime = validateRuntimeEnvironment(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureHttpSecurity(app, runtime);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (runtime.swaggerEnabled) configureSwagger(app);
  await app.listen(runtime.port, '0.0.0.0');
  Logger.log(
    `API ready environment=${runtime.nodeEnvironment} port=${runtime.port} swagger=${runtime.swaggerEnabled ? 'enabled' : 'disabled'} payments=${runtime.paymentProvider}`,
    'Bootstrap',
  );
}
void bootstrap();
