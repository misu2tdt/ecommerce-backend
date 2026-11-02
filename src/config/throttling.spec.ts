import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../users/entities/user-role.enum';
import {
  createCallerResolver,
  emailRequestTracker,
  emailTracker,
  ipOnlyTracker,
  ipTracker,
  normaliseEmail,
  userTracker,
  type ThrottleRequest,
} from './throttling';

const jwt = new JwtService({ secret: 'unit-test-secret-only' });
const foreignJwt = new JwtService({ secret: 'a-different-secret' });
const verify = (token: string) => jwt.verify(token);

const claims = { email: 'shopper@example.test', role: UserRole.USER };

function request(
  overrides: Partial<ThrottleRequest> & { authorization?: string } = {},
): ThrottleRequest {
  const { authorization, ...rest } = overrides;
  return {
    ip: '203.0.113.7',
    headers: authorization ? { authorization } : {},
    body: undefined,
    ...rest,
  };
}

const bearer = (token: string) => `Bearer ${token}`;

describe('throttle tracker strings', () => {
  it('prefixes each kind so a user, an email and an IP can never collide', () => {
    const trackers = [
      userTracker(5),
      emailTracker('user:5'),
      emailTracker('user:5@x.com'),
      emailTracker('5'),
      ipTracker('user:5'),
      ipTracker('203.0.113.7'),
    ];

    expect(new Set(trackers).size).toBe(trackers.length);
    expect(userTracker(5)).toBe('user:5');
    expect(emailTracker('user:5@x.com')).not.toBe(userTracker(5));
    expect(emailTracker('user:5')).not.toBe(userTracker(5));
  });

  it('puts IPv6 addresses of one subnet in the same bucket and keeps IPv4 apart', () => {
    expect(ipTracker('2001:db8:1:2::1')).toBe(ipTracker('2001:db8:1:2::ffff'));
    expect(ipTracker('2001:db8:1:3::1')).not.toBe(ipTracker('2001:db8:1:2::1'));
    expect(ipTracker('203.0.113.7')).not.toBe(ipTracker('203.0.113.8'));
  });

  it('has a bucket for a request without an address', () => {
    expect(ipTracker(undefined)).toBe('ip:unknown');
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases, so spelling variants of one account share a bucket', () => {
    expect(normaliseEmail('  Shopper@Example.TEST ')).toBe(
      'shopper@example.test',
    );
    expect(normaliseEmail('shopper@example.test')).toBe('shopper@example.test');
  });

  it.each([undefined, null, 42, true, {}, ['a@b.test'], '', '   '])(
    'rejects %p',
    (value) => {
      expect(normaliseEmail(value)).toBeNull();
    },
  );

  it('rejects an address longer than any real one', () => {
    expect(normaliseEmail(`${'a'.repeat(250)}@x.test`)).toBeNull();
    expect(normaliseEmail(`${'a'.repeat(240)}@x.test`)).not.toBeNull();
  });
});

describe('caller resolution', () => {
  const resolver = createCallerResolver(verify);

  it('keys a request with a valid token by the user id', () => {
    const token = jwt.sign({ sub: 42, ...claims });

    const caller = resolver.resolve(request({ authorization: bearer(token) }));

    expect(caller).toEqual({ kind: 'user', userId: 42 });
    expect(resolver.tracker(request({ authorization: bearer(token) }))).toBe(
      'user:42',
    );
  });

  it('keeps two users behind one IP apart', () => {
    const first = jwt.sign({ sub: 1, ...claims });
    const second = jwt.sign({ sub: 2, ...claims });

    expect(
      resolver.tracker(request({ authorization: bearer(first) })),
    ).not.toBe(resolver.tracker(request({ authorization: bearer(second) })));
  });

  it('keys a request without a token by IP', () => {
    expect(resolver.tracker(request())).toBe('ip:203.0.113.7');
    expect(resolver.resolve(request())).toEqual({
      kind: 'anonymous',
      ip: '203.0.113.7',
    });
  });

  it.each([
    [
      'a token signed with another secret',
      () => foreignJwt.sign({ sub: 42, ...claims }),
    ],
    [
      'an expired token',
      () => jwt.sign({ sub: 42, ...claims }, { expiresIn: '-10s' }),
    ],
    ['a token that is not a JWT', () => 'not-a-token'],
    [
      'a token with its signature cut off',
      () => {
        const [header, payload] = jwt.sign({ sub: 42, ...claims }).split('.');
        return `${header}.${payload}.`;
      },
    ],
    [
      'an unsigned token (alg none)',
      () => {
        const encode = (value: object) =>
          Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 42, ...claims })}.`;
      },
    ],
    ['a token without a subject', () => jwt.sign({ ...claims })],
    [
      'a token with a non-numeric subject',
      () => jwt.sign({ sub: '42', ...claims }),
    ],
    [
      'a token with a fractional subject',
      () => jwt.sign({ sub: 4.5, ...claims }),
    ],
    ['a token with a negative subject', () => jwt.sign({ sub: -1, ...claims })],
    [
      'a token with an unknown role',
      () => jwt.sign({ sub: 42, email: 'a@b.test', role: 'owner' }),
    ],
  ])('falls back to the IP for %s', (_name, makeToken) => {
    const token = makeToken();

    expect(resolver.tracker(request({ authorization: bearer(token) }))).toBe(
      'ip:203.0.113.7',
    );
  });

  it.each([
    ['a Basic header', 'Basic dXNlcjpwYXNz'],
    ['a bare scheme', 'Bearer'],
    ['an empty token', 'Bearer '],
    ['a lower-case scheme', 'bearer abc'],
  ])('falls back to the IP for %s', (_name, authorization) => {
    expect(resolver.tracker(request({ authorization }))).toBe('ip:203.0.113.7');
  });

  it('never reads a user id from a plain request header', () => {
    const spoofed = request();
    spoofed.headers = {
      'x-user-id': '42',
      'x-forwarded-for': '198.51.100.1',
    } as ThrottleRequest['headers'];

    expect(resolver.tracker(spoofed)).toBe('ip:203.0.113.7');
  });

  it('checks the token once per request', () => {
    const verifyOnce = jest.fn(verify);
    const counted = createCallerResolver(verifyOnce);
    const req = request({
      authorization: bearer(jwt.sign({ sub: 7, ...claims })),
    });

    counted.resolve(req);
    counted.tracker(req);
    counted.resolve(req);

    expect(verifyOnce).toHaveBeenCalledTimes(1);
  });
});

describe('IP-only tracker', () => {
  it('ignores a valid token, so signing in cannot move a request out of the IP bucket', () => {
    const token = jwt.sign({ sub: 42, ...claims });

    expect(ipOnlyTracker(request({ authorization: bearer(token) }))).toBe(
      'ip:203.0.113.7',
    );
  });
});

describe('email tracker', () => {
  it('keys a login by the normalised email, whatever the IP', () => {
    const fromHome = emailRequestTracker(
      request({ ip: '203.0.113.7', body: { email: 'Shopper@Example.test' } }),
    );
    const fromCafe = emailRequestTracker(
      request({
        ip: '198.51.100.9',
        body: { email: ' shopper@example.test ' },
      }),
    );

    expect(fromHome).toBe('email:shopper@example.test');
    expect(fromCafe).toBe(fromHome);
  });

  it('keeps different emails from one IP in different buckets', () => {
    expect(
      emailRequestTracker(request({ body: { email: 'a@example.test' } })),
    ).not.toBe(
      emailRequestTracker(request({ body: { email: 'b@example.test' } })),
    );
  });

  it.each([
    ['no body', undefined],
    ['a body without an email', {}],
    ['an email that is not text', { email: 42 }],
    ['an email list', { email: ['a@example.test'] }],
    ['a blank email', { email: '  ' }],
    ['a body that is not an object', 'a@example.test'],
  ])('falls back to the IP for %s', (_name, body) => {
    expect(emailRequestTracker(request({ body }))).toBe('ip:203.0.113.7');
  });

  it('keeps the email bucket apart from a user bucket of the same text', () => {
    expect(
      emailRequestTracker(request({ body: { email: 'user:5@x.com' } })),
    ).not.toBe(userTracker(5));
  });
});
