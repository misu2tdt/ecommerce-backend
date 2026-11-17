import type { DataSourceOptions } from 'typeorm';
import {
  type ConfigReader,
  getDatabasePort,
  getDatabaseUrl,
  getRequiredConfig,
} from '../config/environment';
import { applyTimestampConvention } from './timestamp-convention';

type PostgresDataSourceOptions = Extract<
  DataSourceOptions,
  { type: 'postgres' }
>;

export type DatabaseOptions = Pick<PostgresDataSourceOptions, 'type'> &
  Partial<
    Pick<
      PostgresDataSourceOptions,
      'host' | 'port' | 'username' | 'password' | 'database' | 'url' | 'ssl'
    >
  >;

const MANAGED_DATABASE_SSL = {
  rejectUnauthorized: true,
} as const;

export function createDatabaseOptions(reader: ConfigReader): DatabaseOptions {
  // Every data source of the app, the seeds and the tests is built from these
  // options, so this is the one place that sets how times are read and written.
  applyTimestampConvention();
  const url = getDatabaseUrl(reader);
  if (url) {
    return {
      type: 'postgres',
      url,
      ssl: MANAGED_DATABASE_SSL,
    };
  }

  return {
    type: 'postgres',
    host: getRequiredConfig(reader, 'DB_HOST'),
    port: getDatabasePort(reader),
    username: getRequiredConfig(reader, 'DB_USERNAME'),
    password: getRequiredConfig(reader, 'DB_PASSWORD'),
    database: getRequiredConfig(reader, 'DB_NAME'),
  };
}
