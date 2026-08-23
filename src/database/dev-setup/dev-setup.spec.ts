import {
  DevSetupConfig,
  DevSetupDependencies,
  loadDevSetupConfig,
  MANAGED_DATABASES,
  missingManagedDatabases,
  runDevSetup,
} from './dev-setup';

const safeEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5434',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: 'not-a-production-secret',
  DB_NAME: 'ecommerce_dev',
};

describe('development setup safety', () => {
  it('resolves only the explicit local defaults', () => {
    expect(loadDevSetupConfig(safeEnvironment)).toMatchObject({
      databaseName: 'ecommerce_dev',
      databasePort: 5434,
      hostPort: 5434,
      containerName: 'ecom_db',
      volumeName: 'ecommerce_postgres_data',
    });
  });

  it.each(['postgres', 'template0', 'template1', 'ecommerce_test', 'other'])(
    'rejects unsafe application database %s',
    (databaseName) => {
      expect(() =>
        loadDevSetupConfig({ ...safeEnvironment, DB_NAME: databaseName }),
      ).toThrow('dev:setup requires DB_NAME=ecommerce_dev');
    },
  );

  it('rejects production, remote hosts and mismatched ports', () => {
    expect(() =>
      loadDevSetupConfig({ ...safeEnvironment, NODE_ENV: 'production' }),
    ).toThrow('disabled in production');
    expect(() =>
      loadDevSetupConfig({ ...safeEnvironment, DB_HOST: 'database.example' }),
    ).toThrow('loopback DB_HOST');
    expect(() =>
      loadDevSetupConfig({
        ...safeEnvironment,
        DEV_DB_HOST_PORT: '55434',
      }),
    ).toThrow('must match');
  });

  it('plans only missing allowlisted databases', () => {
    expect(missingManagedDatabases([])).toEqual(MANAGED_DATABASES);
    expect(missingManagedDatabases(['postgres', 'ecommerce_dev'])).toEqual([
      'ecommerce_test',
    ]);
    expect(missingManagedDatabases([...MANAGED_DATABASES])).toEqual([]);
  });

  it('runs the bounded setup stages in order and reuses existing npm tasks', async () => {
    const calls: string[] = [];
    const dependencies: DevSetupDependencies = {
      startDatabase: jest.fn(async () => {
        calls.push('start');
      }),
      waitForDatabase: jest.fn(async () => {
        calls.push('wait');
      }),
      ensureDatabases: jest.fn(async () => {
        calls.push('ensure');
        return ['ecommerce_test'];
      }),
      runNpmScript: jest.fn(async (script) => {
        calls.push(script);
      }),
    };

    const config: DevSetupConfig = loadDevSetupConfig(safeEnvironment);
    await expect(runDevSetup(config, dependencies)).resolves.toEqual([
      'ecommerce_test',
    ]);
    expect(calls).toEqual([
      'start',
      'wait',
      'ensure',
      'migration:run',
      'seed:demo',
    ]);
  });
});
