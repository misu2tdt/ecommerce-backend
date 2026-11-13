// The safety guard of the concurrency check. It decides, from the environment
// alone, whether the run may start. Pure and unit tested.
//
// The check writes real rows and starts a backend, so it only runs against the
// isolated test database: right name, right NODE_ENV, the test password
// variable, a loopback host and an explicit port that is not the development
// database port. There is no option for a URL: the script only ever talks to the
// backend it starts itself on 127.0.0.1.

export const TEST_DATABASE_NAME = 'ecommerce_test';
export const TEST_PASSWORD_VARIABLE = 'ECOMMERCE_TEST_DB_PASSWORD';
export const FORBIDDEN_DATABASE_PORTS: readonly number[] = [5432];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

export interface LoadTestDatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export class UnsafeEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeEnvironmentError';
  }
}

export type EnvironmentVariables = Record<string, string | undefined>;

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertSafeLoadTestEnvironment(
  env: EnvironmentVariables,
): LoadTestDatabaseConfig {
  if (env.NODE_ENV !== 'test') {
    throw new UnsafeEnvironmentError(
      'Refusing to run: NODE_ENV must be "test".',
    );
  }
  if (present(env.DATABASE_URL)) {
    throw new UnsafeEnvironmentError(
      'Refusing to run: DATABASE_URL is set. This check only uses DB_HOST, DB_PORT and DB_NAME of the isolated test database.',
    );
  }
  if (env.DB_NAME !== TEST_DATABASE_NAME) {
    throw new UnsafeEnvironmentError(
      `Refusing to run: DB_NAME must be exactly "${TEST_DATABASE_NAME}".`,
    );
  }

  const host = present(env.DB_HOST) ? env.DB_HOST.trim() : 'localhost';
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new UnsafeEnvironmentError(
      'Refusing to run: DB_HOST must be this machine (localhost, 127.0.0.1 or ::1).',
    );
  }

  const rawPort = env.DB_PORT?.trim() ?? '';
  if (!/^\d+$/.test(rawPort)) {
    throw new UnsafeEnvironmentError(
      'Refusing to run: DB_PORT must be set to the port of the isolated test database.',
    );
  }
  const port = Number(rawPort);
  if (port < 1 || port > 65535) {
    throw new UnsafeEnvironmentError(
      'Refusing to run: DB_PORT must be between 1 and 65535.',
    );
  }
  if (FORBIDDEN_DATABASE_PORTS.includes(port)) {
    throw new UnsafeEnvironmentError(
      `Refusing to run: port ${port} is the development database port. Use the isolated test database.`,
    );
  }

  if (!present(env[TEST_PASSWORD_VARIABLE])) {
    throw new UnsafeEnvironmentError(
      `Refusing to run: ${TEST_PASSWORD_VARIABLE} must be set (the password of the isolated test database).`,
    );
  }

  return {
    host,
    port,
    username: present(env.DB_USERNAME) ? env.DB_USERNAME.trim() : 'postgres',
    password: env[TEST_PASSWORD_VARIABLE],
    database: TEST_DATABASE_NAME,
  };
}

/**
 * What a live connection reports about itself must agree with the guard, so a
 * proxy or a wrong port can not point the check at another database. Only the
 * database name is compared: a container maps its own port 5432 to another one
 * on this machine, so the port the server reports says nothing.
 */
export function assertConnectedToTestDatabase(reported: {
  database: string;
}): void {
  if (reported.database !== TEST_DATABASE_NAME) {
    throw new UnsafeEnvironmentError(
      `Refusing to run: connected to database "${reported.database}", not "${TEST_DATABASE_NAME}".`,
    );
  }
}
