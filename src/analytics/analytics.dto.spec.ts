import { ValidationPipe } from '@nestjs/common';
import {
  AnalyticsRangeQueryDto,
  TopProductsQueryDto,
} from './dto/analytics-range-query.dto';

// The same pipe the application uses.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const range = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: AnalyticsRangeQueryDto });
const top = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: TopProductsQueryDto });

describe('analytics query validation', () => {
  it('accepts no parameters, or valid ones', async () => {
    await expect(range({})).resolves.toBeInstanceOf(AnalyticsRangeQueryDto);
    await expect(
      range({ from: '2026-10-01', to: '2026-10-31', timezone: 'UTC' }),
    ).resolves.toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      timezone: 'UTC',
    });
  });

  it.each([
    ['from', '2026-1-1'],
    ['from', '2026-10-01T00:00:00Z'],
    ['from', ''],
    ['to', 'tomorrow'],
    ['to', '20261001'],
    ['from', ['2026-10-01', '2026-10-02']],
    ['timezone', ['UTC', 'Asia/Tokyo']],
    ['timezone', 'A'.repeat(65)],
  ])('refuses %s = %p', async (name, value) => {
    await expect(range({ [name]: value })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses parameters it does not know', async () => {
    await expect(range({ period: 'month' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(top({ order: 'asc' })).rejects.toMatchObject({ status: 400 });
  });

  it('limit is a whole number from 1 to 50, left out meaning the default', async () => {
    await expect(top({})).resolves.toMatchObject({ limit: undefined });
    await expect(top({ limit: '1' })).resolves.toMatchObject({ limit: 1 });
    await expect(top({ limit: '50' })).resolves.toMatchObject({ limit: 50 });

    for (const bad of [
      '0',
      '51',
      '-1',
      '1.5',
      '1e1',
      'abc',
      '',
      ' 5',
      ['5', '6'],
    ]) {
      await expect(top({ limit: bad })).rejects.toMatchObject({ status: 400 });
    }
  });
});
