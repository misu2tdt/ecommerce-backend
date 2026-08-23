import type { DataSourceOptions } from 'typeorm';
import {
  assertSafeDemoSeedDatabase,
  DEMO_DEVELOPMENT_DATABASE,
  DEMO_TEST_DATABASE,
  PRODUCTION_DEMO_CONFIRMATION,
} from './demo-seed-safety';

function dataSourceWith(database: string) {
  return {
    options: {
      type: 'postgres',
      database,
      synchronize: false,
      dropSchema: false,
    } as DataSourceOptions,
  };
}

describe('assertSafeDemoSeedDatabase', () => {
  it('accepts only the explicit development target for the real command', () => {
    expect(() =>
      assertSafeDemoSeedDatabase(
        dataSourceWith(DEMO_DEVELOPMENT_DATABASE),
        'development',
        'development',
      ),
    ).not.toThrow();
  });

  it('rejects production before mutation', () => {
    expect(() =>
      assertSafeDemoSeedDatabase(
        dataSourceWith(DEMO_DEVELOPMENT_DATABASE),
        'development',
        'production',
      ),
    ).toThrow('disabled in production');
  });

  it.each([
    'postgres',
    'template0',
    'template1',
    DEMO_TEST_DATABASE,
    'ecommerce_prod',
    'unknown',
  ])('rejects unsafe development database %s', (database) => {
    expect(() =>
      assertSafeDemoSeedDatabase(
        dataSourceWith(database),
        'development',
        'development',
      ),
    ).toThrow(`requires database ${DEMO_DEVELOPMENT_DATABASE}`);
  });

  it('allows the isolated automated-test target only in NODE_ENV=test', () => {
    expect(() =>
      assertSafeDemoSeedDatabase(
        dataSourceWith(DEMO_TEST_DATABASE),
        'test',
        'test',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeDemoSeedDatabase(
        dataSourceWith(DEMO_TEST_DATABASE),
        'test',
        'development',
      ),
    ).toThrow('requires NODE_ENV=test');
  });

  it('requires two explicit confirmations for an idempotent production demo seed', () => {
    const production = dataSourceWith('portfolio_store');
    expect(() =>
      assertSafeDemoSeedDatabase(production, 'production', 'production', {
        confirmation: PRODUCTION_DEMO_CONFIRMATION,
        database: 'portfolio_store',
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeDemoSeedDatabase(production, 'production', 'production', {
        confirmation: PRODUCTION_DEMO_CONFIRMATION,
        database: 'another_database',
      }),
    ).toThrow('database confirmation does not match');
  });

  it.each(['postgres', 'template0', 'template1'])(
    'refuses reserved production database %s',
    (database) => {
      expect(() =>
        assertSafeDemoSeedDatabase(
          dataSourceWith(database),
          'production',
          'production',
          {
            confirmation: PRODUCTION_DEMO_CONFIRMATION,
            database,
          },
        ),
      ).toThrow('refuses a reserved database');
    },
  );

  it('resolves and confirms a production database name from DATABASE_URL', () => {
    const dataSource = {
      options: {
        type: 'postgres',
        url: 'postgresql://app:secret@ep-example.neon.tech/portfolio_store',
        synchronize: false,
        dropSchema: false,
      } as DataSourceOptions & { url: string },
    };

    expect(() =>
      assertSafeDemoSeedDatabase(dataSource, 'production', 'production', {
        confirmation: PRODUCTION_DEMO_CONFIRMATION,
        database: 'portfolio_store',
      }),
    ).not.toThrow();
  });
});
