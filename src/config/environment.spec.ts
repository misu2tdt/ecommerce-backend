import { getPaymentCurrency, validateRuntimeEnvironment } from './environment';

describe('payment currency configuration', () => {
  it('defaults to and normalizes VND', () => {
    expect(getPaymentCurrency(() => undefined)).toBe('VND');
    expect(getPaymentCurrency(() => ' vnd ')).toBe('VND');
  });

  it('rejects unsupported currency instead of retaining a USD fallback', () => {
    expect(() => getPaymentCurrency(() => 'USD')).toThrow(
      'PAYMENT_CURRENCY must be VND',
    );
  });
});

describe('runtime environment validation', () => {
  const core = {
    NODE_ENV: 'production',
    PORT: '3000',
    FRONTEND_ORIGIN: 'https://store.example.com',
    DB_HOST: 'database',
    DB_PORT: '5432',
    DB_USERNAME: 'app',
    DB_PASSWORD: 'secret',
    DB_NAME: 'ecommerce',
    JWT_SECRET: 'secret',
    JWT_EXPIRES_IN: '15m',
  };

  it('disables Swagger in production by default', () => {
    expect(validateRuntimeEnvironment(core)).toMatchObject({
      nodeEnvironment: 'production',
      port: 3000,
      frontendOrigin: 'https://store.example.com',
      swaggerEnabled: false,
    });
  });

  it('allows explicit production Swagger exposure', () => {
    expect(
      validateRuntimeEnvironment({ ...core, SWAGGER_ENABLED: 'true' }),
    ).toMatchObject({ swaggerEnabled: true });
  });

  it.each(['PORT', 'FRONTEND_ORIGIN', 'DB_PASSWORD', 'JWT_SECRET'])(
    'fails production startup when %s is missing',
    (key) => {
      expect(() =>
        validateRuntimeEnvironment({ ...core, [key]: undefined }),
      ).toThrow(key);
    },
  );

  it('rejects wildcard/path CORS origins and invalid booleans', () => {
    expect(() =>
      validateRuntimeEnvironment({ ...core, FRONTEND_ORIGIN: '*' }),
    ).toThrow('HTTP(S) origin');
    expect(() =>
      validateRuntimeEnvironment({
        ...core,
        FRONTEND_ORIGIN: 'https://store.example.com/path',
      }),
    ).toThrow('HTTP(S) origin');
    expect(() =>
      validateRuntimeEnvironment({ ...core, SWAGGER_ENABLED: 'yes' }),
    ).toThrow('true or false');
  });
});
