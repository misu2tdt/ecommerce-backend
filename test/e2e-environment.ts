import { expectedTestDatabaseName } from './integration/database-safety';
import { loadTestEnvironment } from './integration/test-environment';

const databaseEnvironment = loadTestEnvironment();
if (databaseEnvironment.DB_NAME !== expectedTestDatabaseName) {
  throw new Error(`E2E tests require DB_NAME=${expectedTestDatabaseName}`);
}

Object.assign(process.env, databaseEnvironment, {
  FRONTEND_ORIGIN: 'http://localhost:3001',
  JWT_SECRET: 'e2e-only-not-for-production',
  JWT_EXPIRES_IN: '15m',
  CLOUDINARY_CLOUD_NAME: 'e2e-disabled',
  CLOUDINARY_API_KEY: 'e2e-disabled',
  CLOUDINARY_API_SECRET: 'e2e-disabled',
  PAYMENT_CURRENCY: 'VND',
  MOMO_PARTNER_CODE: 'e2e-disabled',
  MOMO_ACCESS_KEY: 'e2e-disabled',
  MOMO_SECRET_KEY: 'e2e-disabled',
  MOMO_IDENTITY_SECRET: 'e2e-only-identity',
  MOMO_ENDPOINT: 'https://momo.invalid',
  MOMO_REDIRECT_URL: 'http://localhost:3001/payment-return',
  MOMO_IPN_URL: 'http://localhost:3000/payments/webhooks/momo',
});
