import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { validateRuntimeEnvironment } from './config/environment';
import { configureSwagger } from './docs/swagger';

async function bootstrap() {
  const runtime = validateRuntimeEnvironment(process.env);
  const app = await NestFactory.create(AppModule);
  if (runtime.frontendOrigin) {
    app.enableCors({ origin: runtime.frontendOrigin });
  }
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (runtime.swaggerEnabled) configureSwagger(app);
  await app.listen(runtime.port);
}
void bootstrap();
