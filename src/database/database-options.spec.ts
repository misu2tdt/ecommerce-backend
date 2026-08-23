import { createDatabaseOptions } from './database-options';

describe('database connection options', () => {
  it('uses a managed PostgreSQL URL with certificate verification', () => {
    const options = createDatabaseOptions((key) =>
      key === 'DATABASE_URL'
        ? 'postgresql://app:secret@ep-example.neon.tech/store?sslmode=require'
        : undefined,
    );

    expect(options).toEqual({
      type: 'postgres',
      url: 'postgresql://app:secret@ep-example.neon.tech/store?sslmode=require',
      ssl: { rejectUnauthorized: true },
    });
  });

  it('preserves split local PostgreSQL configuration without TLS', () => {
    const values: Record<string, string> = {
      DB_HOST: '127.0.0.1',
      DB_PORT: '5434',
      DB_USERNAME: 'postgres',
      DB_PASSWORD: 'local-only',
      DB_NAME: 'ecommerce_dev',
    };

    expect(createDatabaseOptions((key) => values[key])).toEqual({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5434,
      username: 'postgres',
      password: 'local-only',
      database: 'ecommerce_dev',
    });
  });
});
