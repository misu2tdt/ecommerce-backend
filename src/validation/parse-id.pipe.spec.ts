import { BadRequestException } from '@nestjs/common';
import { INT_MAX } from './limits';
import { ParseIdPipe } from './parse-id.pipe';

describe('ParseIdPipe', () => {
  const pipe = new ParseIdPipe();
  const run = (value: string | number) =>
    pipe.transform(value, { type: 'param', data: 'orderId' });

  it.each([
    ['1', 1],
    ['42', 42],
    [String(INT_MAX), INT_MAX],
    // Still passed on, as ParseIntPipe did: the service answers 404.
    ['0', 0],
    ['-5', -5],
  ])('passes %s on as %d', (value, expected) => {
    expect(run(value)).toBe(expected);
  });

  it.each([
    String(INT_MAX + 1),
    '99999999999',
    '9007199254740993',
    '99999999999999999999999',
    String(-(INT_MAX + 1)),
  ])('refuses %s, which does not fit a PostgreSQL integer', (value) => {
    expect(() => run(value)).toThrow(BadRequestException);
    expect(() => run(value)).toThrow('orderId must not be greater than');
  });

  // The global ValidationPipe turns a numeric parameter into a number first.
  it.each([
    [121, 121],
    [INT_MAX, INT_MAX],
  ])('passes the number %d on as %d', (value, expected) => {
    expect(run(value)).toBe(expected);
  });

  it.each([99_999_999_999, INT_MAX + 1, 1e20])(
    'refuses the number %d, which does not fit an integer',
    (value) => {
      expect(() => run(value)).toThrow('orderId must not be greater than');
    },
  );

  it.each([NaN, 1.5, Infinity])(
    'refuses the number %d as not a whole number',
    (value) => {
      expect(() => run(value)).toThrow('orderId must be a whole number');
    },
  );

  it.each(['abc', '', '1.5', '1e3', '0x10', ' ', '12abc'])(
    'refuses "%s" as not a whole number',
    (value) => {
      expect(() => run(value)).toThrow(BadRequestException);
      expect(() => run(value)).toThrow('orderId must be a whole number');
    },
  );
});
