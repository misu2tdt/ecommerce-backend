import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const requiredKeys = [
  'NODE_ENV',
  'DB_HOST',
  'DB_PORT',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_NAME',
] as const;

export type TestEnvironment = Record<(typeof requiredKeys)[number], string>;

function resolveEnvironmentReference(value: string): string {
  const match = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value);

  if (!match) {
    return value;
  }

  const resolvedValue = process.env[match[1]];
  if (typeof resolvedValue !== 'string' || resolvedValue.trim().length === 0) {
    throw new Error(`${match[1]} must be configured for integration tests`);
  }

  return resolvedValue;
}

export function loadTestEnvironment(): TestEnvironment {
  const environmentPath = resolve(process.cwd(), '.env.test');
  if (!existsSync(environmentPath)) {
    throw new Error('.env.test is required for integration tests');
  }

  const parsed = parse(readFileSync(environmentPath));
  const environment = {} as TestEnvironment;

  for (const key of requiredKeys) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${key} must be configured in .env.test`);
    }

    environment[key] = resolveEnvironmentReference(value.trim());
  }

  if (environment.NODE_ENV !== 'test') {
    throw new Error('NODE_ENV in .env.test must be test');
  }

  for (const key of requiredKeys) {
    process.env[key] = environment[key];
  }

  return environment;
}
