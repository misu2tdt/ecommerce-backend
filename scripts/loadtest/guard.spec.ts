import {
  assertConnectedToTestDatabase,
  assertSafeLoadTestEnvironment,
  UnsafeEnvironmentError,
} from './guard';

const safe = {
  NODE_ENV: 'test',
  DB_NAME: 'ecommerce_test',
  DB_PORT: '5434',
  ECOMMERCE_TEST_DB_PASSWORD: 'placeholder-password',
};

function refusal(overrides: Record<string, string | undefined>) {
  return () => assertSafeLoadTestEnvironment({ ...safe, ...overrides });
}

describe('load test safety guard', () => {
  it('accepts the isolated test database and fills the defaults', () => {
    expect(assertSafeLoadTestEnvironment(safe)).toEqual({
      host: 'localhost',
      port: 5434,
      username: 'postgres',
      password: 'placeholder-password',
      database: 'ecommerce_test',
    });
  });

  it('accepts a loopback address and a custom user', () => {
    expect(
      assertSafeLoadTestEnvironment({
        ...safe,
        DB_HOST: '127.0.0.1',
        DB_USERNAME: 'tester',
      }),
    ).toMatchObject({ host: '127.0.0.1', username: 'tester' });
  });

  it.each(['production', 'development', undefined, ''])(
    'refuses NODE_ENV %j',
    (value) => {
      expect(refusal({ NODE_ENV: value })).toThrow(UnsafeEnvironmentError);
      expect(refusal({ NODE_ENV: value })).toThrow(/NODE_ENV must be "test"/);
    },
  );

  it.each([
    'ecommerce_dev',
    'ecommerce_prod',
    'postgres',
    'ecommerce_test_2',
    'ECOMMERCE_TEST',
    '',
    undefined,
  ])('refuses the database name %j', (name) => {
    expect(refusal({ DB_NAME: name })).toThrow(UnsafeEnvironmentError);
    expect(refusal({ DB_NAME: name })).toThrow(/DB_NAME must be exactly/);
  });

  it('refuses a DATABASE_URL, which could point anywhere', () => {
    expect(
      refusal({
        DATABASE_URL: 'postgres://u:p@prod.example.com/ecommerce_test',
      }),
    ).toThrow(/DATABASE_URL is set/);
  });

  it.each(['db.example.com', '10.0.0.5', 'prod.internal'])(
    'refuses the remote host %s',
    (host) => {
      expect(refusal({ DB_HOST: host })).toThrow(/must be this machine/);
    },
  );

  it('needs an explicit database port and refuses the development port', () => {
    expect(refusal({ DB_PORT: undefined })).toThrow(/DB_PORT must be set/);
    expect(refusal({ DB_PORT: 'abc' })).toThrow(/DB_PORT must be set/);
    expect(refusal({ DB_PORT: '0' })).toThrow(/between 1 and 65535/);
    expect(refusal({ DB_PORT: '70000' })).toThrow(/between 1 and 65535/);
    expect(refusal({ DB_PORT: '5432' })).toThrow(/development database port/);
  });

  it('needs the test password variable and never prints it', () => {
    expect(refusal({ ECOMMERCE_TEST_DB_PASSWORD: undefined })).toThrow(
      /ECOMMERCE_TEST_DB_PASSWORD must be set/,
    );
    expect(refusal({ ECOMMERCE_TEST_DB_PASSWORD: '  ' })).toThrow(
      /ECOMMERCE_TEST_DB_PASSWORD must be set/,
    );
    try {
      refusal({ DB_NAME: 'ecommerce_dev' })();
    } catch (error) {
      expect((error as Error).message).not.toContain('placeholder-password');
    }
  });

  it('ignores DB_PASSWORD: only the test password variable counts', () => {
    expect(
      assertSafeLoadTestEnvironment({
        ...safe,
        DB_PASSWORD: 'production-secret',
      }).password,
    ).toBe('placeholder-password');
  });

  describe('connected database', () => {
    it('accepts a server that reports the test database', () => {
      expect(() =>
        assertConnectedToTestDatabase({ database: 'ecommerce_test' }),
      ).not.toThrow();
    });

    it('refuses any other database the connection reports', () => {
      for (const database of ['ecommerce_dev', 'postgres', 'ecommerce_prod']) {
        expect(() => assertConnectedToTestDatabase({ database })).toThrow(
          UnsafeEnvironmentError,
        );
        expect(() => assertConnectedToTestDatabase({ database })).toThrow(
          /not "ecommerce_test"/,
        );
      }
    });
  });
});
