import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import { ResolveReconciliationDto } from './dto/resolve-reconciliation.dto';

async function checkQuery(raw: Record<string, unknown>) {
  const dto = plainToInstance(ReconciliationQueryDto, raw);
  return { dto, errors: await validate(dto) };
}

async function checkResolve(raw: Record<string, unknown>) {
  const dto = plainToInstance(ResolveReconciliationDto, raw);
  return { dto, errors: await validate(dto) };
}

describe('ReconciliationQueryDto', () => {
  it('defaults to page 1, limit 20 and unresolved events', async () => {
    const { dto, errors } = await checkQuery({});

    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 1, limit: 20, status: 'unresolved' });
  });

  it('converts query-string numbers and accepts the allowed bounds', async () => {
    const { dto, errors } = await checkQuery({
      page: '3',
      limit: '100',
      status: 'all',
    });

    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 3, limit: 100, status: 'all' });
  });

  it.each([
    ['limit above 100 is rejected, not clamped', { limit: '101' }],
    ['limit below 1', { limit: '0' }],
    ['page below 1', { page: '0' }],
    ['non-integer page', { page: '1.5' }],
    ['non-numeric limit', { limit: 'many' }],
    ['unknown status', { status: 'everything' }],
  ])('rejects %s', async (_label, raw) => {
    const { errors } = await checkQuery(raw);

    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ResolveReconciliationDto', () => {
  it('trims the note before validating and keeping it', async () => {
    const { dto, errors } = await checkResolve({
      note: '  Refunded in the MoMo portal  ',
    });

    expect(errors).toHaveLength(0);
    expect(dto.note).toBe('Refunded in the MoMo portal');
  });

  it('accepts the 3 and 500 character limits', async () => {
    expect((await checkResolve({ note: 'abc' })).errors).toHaveLength(0);
    expect((await checkResolve({ note: 'a'.repeat(500) })).errors).toHaveLength(
      0,
    );
  });

  it.each([
    ['missing', {}],
    ['empty', { note: '' }],
    ['blank', { note: '     ' }],
    ['shorter than 3 after trimming', { note: '  ab  ' }],
    ['longer than 500', { note: 'a'.repeat(501) }],
    ['not a string', { note: 12345 }],
  ])('rejects a note that is %s', async (_label, raw) => {
    const { errors } = await checkResolve(raw);

    expect(errors.length).toBeGreaterThan(0);
  });
});
