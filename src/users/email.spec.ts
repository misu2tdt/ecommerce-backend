import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from '../auth/dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { isReservedEmailDomain, normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Shopper@Example.TEST ')).toBe(
      'shopper@example.test',
    );
    expect(normalizeEmail('a@x.com')).toBe(normalizeEmail('A@X.COM'));
  });
});

describe('isReservedEmailDomain', () => {
  it.each([
    'someone@demo-history.example.com',
    'Someone@Demo-History.Example.COM',
    ' someone@demo-history.example.com ',
  ])('refuses %s', (email) => {
    expect(isReservedEmailDomain(email)).toBe(true);
  });

  it.each([
    'someone@example.com',
    'demo-history.example.com@gmail.com',
    'someone@mail.demo-history.example.com',
    'someone@demo-history.example.com.evil.test',
  ])('allows %s', (email) => {
    expect(isReservedEmailDomain(email)).toBe(false);
  });
});

describe('email normalisation in the DTOs', () => {
  it.each([CreateUserDto, LoginDto])(
    'the %p lowercases and trims before validating',
    async (type) => {
      const dto = plainToInstance(type, {
        email: '  Shopper@Example.TEST ',
        password: 'long-enough-1',
      });
      expect(dto.email).toBe('shopper@example.test');
      expect(await validate(dto)).toHaveLength(0);
    },
  );

  it('still rejects something that is not an email', async () => {
    const dto = plainToInstance(CreateUserDto, {
      email: ' not an email ',
      password: 'long-enough-1',
    });
    expect((await validate(dto)).map((e) => e.property)).toEqual(['email']);
  });

  it('leaves a non-string alone for the validator to refuse', async () => {
    const dto = plainToInstance(LoginDto, { email: 42, password: 'x' });
    expect((await validate(dto)).map((e) => e.property)).toContain('email');
  });
});
