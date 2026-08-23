import type { DataSourceOptions } from 'typeorm';

export const DEMO_DEVELOPMENT_DATABASE = 'ecommerce_dev';
export const DEMO_TEST_DATABASE = 'ecommerce_test';
export const PRODUCTION_DEMO_CONFIRMATION = 'SEED_PORTFOLIO_DEMO';

export type DemoSeedTarget = 'development' | 'test' | 'production';

export interface ProductionDemoApproval {
  confirmation?: string;
  database?: string;
}

type GuardedDataSource = {
  options: DataSourceOptions & { url?: string };
};

export function assertSafeDemoSeedDatabase(
  dataSource: GuardedDataSource,
  target: DemoSeedTarget,
  nodeEnvironment = process.env.NODE_ENV,
  productionApproval?: ProductionDemoApproval,
): void {
  const database = resolveDatabaseName(dataSource.options);

  if (target === 'production') {
    assertProductionApproval(database, nodeEnvironment, productionApproval);
  } else {
    if (nodeEnvironment === 'production') {
      throw new Error(
        'Development and test demo seeds are disabled in production',
      );
    }
    const expectedDatabase =
      target === 'development' ? DEMO_DEVELOPMENT_DATABASE : DEMO_TEST_DATABASE;
    if (database !== expectedDatabase) {
      throw new Error(
        `Demo seed target ${target} requires database ${expectedDatabase}`,
      );
    }
    if (target === 'test' && nodeEnvironment !== 'test') {
      throw new Error('Demo seed test target requires NODE_ENV=test');
    }
  }

  if (dataSource.options.synchronize !== false) {
    throw new Error('Demo seed DataSource synchronize must be false');
  }
  if (dataSource.options.dropSchema !== false) {
    throw new Error('Demo seed DataSource dropSchema must be false');
  }
}

function assertProductionApproval(
  database: string,
  nodeEnvironment: string | undefined,
  approval: ProductionDemoApproval | undefined,
): void {
  if (nodeEnvironment !== 'production') {
    throw new Error('Production demo seed requires NODE_ENV=production');
  }
  if (['postgres', 'template0', 'template1'].includes(database)) {
    throw new Error('Production demo seed refuses a reserved database');
  }
  if (approval?.confirmation !== PRODUCTION_DEMO_CONFIRMATION) {
    throw new Error('Production demo seed requires explicit confirmation');
  }
  if (!approval.database || approval.database !== database) {
    throw new Error(
      'Production demo seed database confirmation does not match',
    );
  }
}

function resolveDatabaseName(options: GuardedDataSource['options']): string {
  if (typeof options.database === 'string' && options.database.trim()) {
    return options.database.trim();
  }
  if (typeof options.url === 'string') {
    try {
      const name = decodeURIComponent(new URL(options.url).pathname.slice(1));
      if (name) return name;
    } catch {
      // The database configuration validator reports malformed URLs first.
    }
  }
  throw new Error('Resolved demo seed database must be a non-empty string');
}
