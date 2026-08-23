import type { JwtSignOptions } from '@nestjs/jwt';

export type ConfigReader = (key: string) => unknown;

export interface RuntimeEnvironment {
  nodeEnvironment: 'development' | 'test' | 'production';
  port: number;
  frontendOrigin?: string;
  swaggerEnabled: boolean;
}

export function getRequiredConfig(reader: ConfigReader, key: string): string {
  const value = reader(key);

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be configured`);
  }

  return value;
}

export function getDatabasePort(reader: ConfigReader): number {
  const rawPort = getRequiredConfig(reader, 'DB_PORT');
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535');
  }

  return port;
}

export function getDatabaseUrl(reader: ConfigReader): string | undefined {
  const configured = reader('DATABASE_URL');
  if (configured === undefined || configured === '') return undefined;
  if (typeof configured !== 'string') {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }

  try {
    const url = new URL(configured.trim());
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname === '/'
    ) {
      throw new Error();
    }
    return configured.trim();
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
}

export function getJwtExpiration(
  reader: ConfigReader,
): JwtSignOptions['expiresIn'] {
  const value = getRequiredConfig(reader, 'JWT_EXPIRES_IN').trim();

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds) && seconds > 0) {
      return seconds;
    }
  }

  if (/^[1-9]\d*(?:\.\d+)?(?:ms|s|m|h|d|w|y)$/i.test(value)) {
    return value as JwtSignOptions['expiresIn'];
  }

  throw new Error(
    'JWT_EXPIRES_IN must be positive seconds or a duration such as 15m',
  );
}

export function getPaymentCurrency(
  reader: ConfigReader,
  fallback = 'VND',
): string {
  const configured = reader('PAYMENT_CURRENCY');
  const currency =
    typeof configured === 'string' && configured.trim().length > 0
      ? configured.trim().toUpperCase()
      : fallback;
  if (currency !== 'VND') throw new Error('PAYMENT_CURRENCY must be VND');
  return currency;
}

export function validateRuntimeEnvironment(
  environment: Record<string, unknown>,
): RuntimeEnvironment {
  const readConfig = (key: string) => environment[key];
  const nodeEnvironment = readNodeEnvironment(readConfig('NODE_ENV'));

  if (!getDatabaseUrl(readConfig)) {
    getRequiredConfig(readConfig, 'DB_HOST');
    getDatabasePort(readConfig);
    getRequiredConfig(readConfig, 'DB_USERNAME');
    getRequiredConfig(readConfig, 'DB_PASSWORD');
    getRequiredConfig(readConfig, 'DB_NAME');
  }
  getRequiredConfig(readConfig, 'JWT_SECRET');
  getJwtExpiration(readConfig);

  return {
    nodeEnvironment,
    port: readApplicationPort(readConfig('PORT'), nodeEnvironment),
    frontendOrigin: readFrontendOrigin(
      readConfig('FRONTEND_ORIGIN'),
      nodeEnvironment,
    ),
    swaggerEnabled: readBoolean(
      readConfig('SWAGGER_ENABLED'),
      nodeEnvironment !== 'production',
      'SWAGGER_ENABLED',
    ),
  };
}

function readNodeEnvironment(
  value: unknown,
): RuntimeEnvironment['nodeEnvironment'] {
  const normalized =
    typeof value === 'string' && value.trim() ? value.trim() : 'development';
  if (!['development', 'test', 'production'].includes(normalized)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  return normalized as RuntimeEnvironment['nodeEnvironment'];
}

function readApplicationPort(
  value: unknown,
  nodeEnvironment: RuntimeEnvironment['nodeEnvironment'],
): number {
  if (
    (value === undefined || value === '') &&
    nodeEnvironment !== 'production'
  ) {
    return 3000;
  }
  const port = Number(getRequiredConfig(() => value, 'PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readFrontendOrigin(
  value: unknown,
  nodeEnvironment: RuntimeEnvironment['nodeEnvironment'],
): string | undefined {
  if (
    (value === undefined || value === '') &&
    nodeEnvironment !== 'production'
  ) {
    return undefined;
  }
  const configured = getRequiredConfig(() => value, 'FRONTEND_ORIGIN');
  try {
    const url = new URL(configured);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== configured
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('FRONTEND_ORIGIN must be an HTTP(S) origin without a path');
  }
}

function readBoolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !['true', 'false'].includes(value.trim())) {
    throw new Error(`${key} must be true or false`);
  }
  return value.trim() === 'true';
}
