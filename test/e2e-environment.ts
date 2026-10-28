import { expectedTestDatabaseName } from './integration/database-safety';
import { loadTestEnvironment } from './integration/test-environment';
import { testRuntimeEnvironment } from './support/test-runtime-env';

const databaseEnvironment = loadTestEnvironment();
if (databaseEnvironment.DB_NAME !== expectedTestDatabaseName) {
  throw new Error(`E2E tests require DB_NAME=${expectedTestDatabaseName}`);
}

Object.assign(process.env, databaseEnvironment, testRuntimeEnvironment);
