import type { DataSource } from 'typeorm';
import { PRODUCTION_DEMO_CONFIRMATION } from '../demo-seed-safety';
import { seedOrderHistory } from './order-history';

// A stand-in that fails loudly if the seed touches it: every refusal below must
// happen before any database access.
function untouchableDataSource(
  database: string,
  overrides: Record<string, unknown> = {},
): DataSource {
  const fail = () => {
    throw new Error('The database must not be used when the guard refuses');
  };
  return {
    options: {
      type: 'postgres',
      database,
      synchronize: false,
      dropSchema: false,
      ...overrides,
    },
    isInitialized: true,
    transaction: fail,
    query: fail,
    getRepository: fail,
  } as unknown as DataSource;
}

describe('order history guard', () => {
  it('only runs on ecommerce_dev for the development target', async () => {
    for (const database of ['ecommerce_test', 'postgres', 'production_db']) {
      await expect(
        seedOrderHistory(untouchableDataSource(database), {
          target: 'development',
          nodeEnvironment: 'development',
        }),
      ).rejects.toThrow('requires database ecommerce_dev');
    }
  });

  it('only runs on ecommerce_test, with NODE_ENV=test, for the test target', async () => {
    await expect(
      seedOrderHistory(untouchableDataSource('ecommerce_dev'), {
        target: 'test',
        nodeEnvironment: 'test',
      }),
    ).rejects.toThrow('requires database ecommerce_test');
    await expect(
      seedOrderHistory(untouchableDataSource('ecommerce_test'), {
        target: 'test',
        nodeEnvironment: 'development',
      }),
    ).rejects.toThrow('requires NODE_ENV=test');
  });

  it('is disabled for the development and test targets when NODE_ENV is production', async () => {
    for (const target of ['development', 'test'] as const) {
      await expect(
        seedOrderHistory(untouchableDataSource('ecommerce_dev'), {
          target,
          nodeEnvironment: 'production',
        }),
      ).rejects.toThrow('disabled in production');
    }
  });

  it('needs the explicit production confirmation, a matching database and NODE_ENV=production', async () => {
    const dataSource = untouchableDataSource('demo_database');

    await expect(
      seedOrderHistory(dataSource, {
        target: 'production',
        nodeEnvironment: 'development',
        productionApproval: {
          confirmation: PRODUCTION_DEMO_CONFIRMATION,
          database: 'demo_database',
        },
      }),
    ).rejects.toThrow('requires NODE_ENV=production');
    await expect(
      seedOrderHistory(dataSource, {
        target: 'production',
        nodeEnvironment: 'production',
      }),
    ).rejects.toThrow('explicit confirmation');
    await expect(
      seedOrderHistory(dataSource, {
        target: 'production',
        nodeEnvironment: 'production',
        productionApproval: { confirmation: 'yes', database: 'demo_database' },
      }),
    ).rejects.toThrow('explicit confirmation');
    await expect(
      seedOrderHistory(dataSource, {
        target: 'production',
        nodeEnvironment: 'production',
        productionApproval: {
          confirmation: PRODUCTION_DEMO_CONFIRMATION,
          database: 'another_database',
        },
      }),
    ).rejects.toThrow('database confirmation does not match');
  });

  it('refuses reserved databases even with the confirmation', async () => {
    for (const database of ['postgres', 'template0', 'template1']) {
      await expect(
        seedOrderHistory(untouchableDataSource(database), {
          target: 'production',
          nodeEnvironment: 'production',
          productionApproval: {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database,
          },
        }),
      ).rejects.toThrow('reserved database');
    }
  });

  it('refuses a data source that could change the schema', async () => {
    await expect(
      seedOrderHistory(
        untouchableDataSource('ecommerce_dev', { synchronize: true }),
        { target: 'development', nodeEnvironment: 'development' },
      ),
    ).rejects.toThrow('synchronize must be false');
    await expect(
      seedOrderHistory(
        untouchableDataSource('ecommerce_dev', { dropSchema: true }),
        { target: 'development', nodeEnvironment: 'development' },
      ),
    ).rejects.toThrow('dropSchema must be false');
  });
});
