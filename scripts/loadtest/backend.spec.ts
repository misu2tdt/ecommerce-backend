import { buildBackendEnvironment } from './backend';
import { assertSafeLoadTestEnvironment } from './guard';
import { markersForLeftovers, markersForRun } from './database';

const database = assertSafeLoadTestEnvironment({
  NODE_ENV: 'test',
  DB_NAME: 'ecommerce_test',
  DB_PORT: '5434',
  ECOMMERCE_TEST_DB_PASSWORD: 'placeholder-password',
});

describe('environment of the child backend', () => {
  const hostile = {
    PATH: '/usr/bin',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@prod.example.com/ecommerce',
    DB_NAME: 'ecommerce_prod',
    DB_HOST: 'prod.example.com',
    DB_PORT: '5432',
    DB_PASSWORD: 'production-secret',
    PAYMENT_PROVIDER: 'momo',
    TELEGRAM_BOT_TOKEN: 'real-token',
    TELEGRAM_CHAT_ID: 'real-chat',
    JWT_SECRET: 'production-jwt-secret',
    PORT: '8080',
  };
  const environment = buildBackendEnvironment(
    hostile,
    database,
    4567,
    'run-secret',
  );

  it('points the backend at the test database only', () => {
    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      DB_HOST: 'localhost',
      DB_PORT: '5434',
      DB_USERNAME: 'postgres',
      DB_PASSWORD: 'placeholder-password',
      DB_NAME: 'ecommerce_test',
      DATABASE_URL: '',
    });
  });

  it('uses the demo provider, the chosen port and the run secret', () => {
    expect(environment).toMatchObject({
      PAYMENT_PROVIDER: 'demo',
      PORT: '4567',
      JWT_SECRET: 'run-secret',
      TZ: 'UTC',
      SWAGGER_ENABLED: 'false',
    });
  });

  it('can not send a notification out of this machine', () => {
    expect(environment.TELEGRAM_BOT_TOKEN).toBe('');
    expect(environment.TELEGRAM_CHAT_ID).toBe('');
    expect(environment.TELEGRAM_ADMIN_CHAT_ID).toBe('');
  });

  it('keeps unrelated variables such as PATH', () => {
    expect(environment.PATH).toBe('/usr/bin');
  });
});

describe('run markers', () => {
  it('limit a clean-up to the rows of one run', () => {
    expect(markersForRun('ab12cd34')).toEqual({
      runId: 'ab12cd34',
      emailPattern: 'loadtest-ab12cd34-%@loadtest.invalid',
      skuPattern: 'LOADTEST-ab12cd34-%',
      slugPattern: 'loadtest-ab12cd34%',
    });
  });

  it('cover every run when sweeping leftovers, and nothing else', () => {
    const markers = markersForLeftovers();
    expect(markers.emailPattern).toBe('loadtest-%@loadtest.invalid');
    expect(markers.skuPattern).toBe('LOADTEST-%');
    expect(markers.slugPattern).toBe('loadtest-%');
  });

  it('use no LIKE wildcard other than the closing one', () => {
    for (const pattern of Object.values(markersForRun('ab12cd34'))) {
      expect(pattern).not.toContain('_');
    }
  });
});
