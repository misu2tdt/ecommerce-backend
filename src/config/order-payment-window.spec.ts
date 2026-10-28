import {
  getOrderPaymentWindowMinutes,
  validateRuntimeEnvironment,
} from './environment';

describe('order payment window configuration', () => {
  it('defaults to 30 minutes when the variable is absent or blank', () => {
    expect(getOrderPaymentWindowMinutes(() => undefined)).toBe(30);
    expect(getOrderPaymentWindowMinutes(() => '')).toBe(30);
    expect(getOrderPaymentWindowMinutes(() => '   ')).toBe(30);
  });

  it.each([
    ['5', 5],
    [' 45 ', 45],
    ['1440', 1440],
  ])('accepts %p', (raw, expected) => {
    expect(getOrderPaymentWindowMinutes(() => raw)).toBe(expected);
  });

  it.each(['4', '1441', '0', '-10', '30.5', '1e3', 'abc', '30m'])(
    'rejects %p',
    (raw) => {
      expect(() => getOrderPaymentWindowMinutes(() => raw)).toThrow(
        'ORDER_PAYMENT_WINDOW_MINUTES must be an integer between 5 and 1440',
      );
    },
  );

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

    it('still boots in production without the optional variable', () => {
      expect(() => validateRuntimeEnvironment(core)).not.toThrow();
    });

    it('accepts a valid value', () => {
      expect(() =>
        validateRuntimeEnvironment({
          ...core,
          ORDER_PAYMENT_WINDOW_MINUTES: '60',
        }),
      ).not.toThrow();
    });

    it('fails startup on an invalid value', () => {
      expect(() =>
        validateRuntimeEnvironment({
          ...core,
          ORDER_PAYMENT_WINDOW_MINUTES: '2',
        }),
      ).toThrow('ORDER_PAYMENT_WINDOW_MINUTES');
    });
  });
});
