import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  applyPaginationHeaders,
  CATALOG_PAGE_SIZE,
  LIST_PAGE_SIZE,
  ListPaginationQueryDto,
  listWithPaging,
  MAX_PAGE,
  paginationHeaders,
  resolvePaging,
} from './pagination';
import { ProductQueryDto } from '../products/dto/product-query.dto';

describe('resolvePaging', () => {
  it('means "no paging" when neither page nor limit is given', () => {
    expect(resolvePaging({}, CATALOG_PAGE_SIZE)).toBeNull();
  });

  it('defaults to page 1 and the default limit once either one is given', () => {
    expect(resolvePaging({ page: 1 }, CATALOG_PAGE_SIZE)).toEqual({
      page: 1,
      limit: 12,
      offset: 0,
    });
    expect(resolvePaging({ limit: 5 }, CATALOG_PAGE_SIZE)).toEqual({
      page: 1,
      limit: 5,
      offset: 0,
    });
    expect(resolvePaging({ page: 2 }, LIST_PAGE_SIZE)).toEqual({
      page: 2,
      limit: 20,
      offset: 20,
    });
  });

  it.each([
    [1, 12, 0],
    [2, 12, 12],
    [3, 7, 14],
    [5, 48, 192],
    [100_000, 48, 4_799_952],
  ])('page %i of %i rows starts at row offset %i', (page, limit, offset) => {
    expect(resolvePaging({ page, limit }, CATALOG_PAGE_SIZE)).toEqual({
      page,
      limit,
      offset,
    });
  });
});

describe('paginationHeaders', () => {
  it('reports the total, the page count, the page and the limit', () => {
    expect(paginationHeaders(30, { page: 2, limit: 12 })).toEqual({
      'X-Total-Count': '30',
      'X-Total-Pages': '3',
      'X-Page': '2',
      'X-Limit': '12',
    });
  });

  it.each([
    [0, 12, 0],
    [1, 12, 1],
    [12, 12, 1],
    [13, 12, 2],
    [24, 12, 2],
    [25, 12, 3],
  ])('%i rows at %i a page make %i pages', (total, limit, pages) => {
    expect(paginationHeaders(total, { page: 1, limit })['X-Total-Pages']).toBe(
      String(pages),
    );
  });

  it('sets all four on a response', () => {
    const setHeader = jest.fn();

    applyPaginationHeaders({ setHeader }, 5, { page: 1, limit: 2 });

    expect(setHeader.mock.calls).toEqual([
      ['X-Total-Count', '5'],
      ['X-Total-Pages', '3'],
      ['X-Page', '1'],
      ['X-Limit', '2'],
    ]);
  });
});

describe('listWithPaging', () => {
  const response = () => ({ setHeader: jest.fn() });

  it('returns the whole list, without headers, when paging was not asked for', async () => {
    const res = response();
    const loadPage = jest.fn();

    const result = await listWithPaging(
      res,
      {},
      LIST_PAGE_SIZE,
      () => Promise.resolve(['a', 'b', 'c']),
      loadPage,
    );

    expect(result).toEqual(['a', 'b', 'c']);
    expect(loadPage).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('returns one page and sets the headers when it was', async () => {
    const res = response();
    const loadAll = jest.fn();

    const result = await listWithPaging(
      res,
      { page: 2, limit: 2 },
      LIST_PAGE_SIZE,
      loadAll,
      (paging) =>
        Promise.resolve({ items: [`row ${paging.offset}`], total: 5 }),
    );

    expect(result).toEqual(['row 2']);
    expect(loadAll).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '5');
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Pages', '3');
  });
});

describe('paging query validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const run = (value: object, metatype: new () => object) =>
    pipe.transform(value, { type: 'query', metatype });

  it('turns digit strings into numbers', async () => {
    const dto = (await run(
      { page: '3', limit: '48' },
      ProductQueryDto,
    )) as ProductQueryDto;

    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(48);
  });

  it('leaves both unset when they are not sent', async () => {
    const dto = (await run({}, ProductQueryDto)) as ProductQueryDto;

    expect(dto.page).toBeUndefined();
    expect(dto.limit).toBeUndefined();
  });

  it.each([
    ['page', '0'],
    ['page', '-1'],
    ['page', 'abc'],
    ['page', '1.5'],
    ['page', '1e1'],
    ['page', '0x10'],
    ['page', ' 2'],
    ['page', ''],
    ['page', ['1', '2']],
    ['page', String(MAX_PAGE + 1)],
    ['limit', '0'],
    ['limit', '49'],
    ['limit', 'abc'],
    ['limit', '-5'],
    ['limit', ''],
  ])(
    'rejects %s=%p for the catalog with a message about that field',
    async (field, value) => {
      const failure = await run({ [field]: value }, ProductQueryDto).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(BadRequestException);
      const messages = (failure as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(messages.message.length).toBeGreaterThan(0);
      for (const message of messages.message) {
        expect(message).toMatch(new RegExp(`^${field} must`));
      }
    },
  );

  it('allows up to 100 rows on the order and admin lists, and no more', async () => {
    const ok = (await run(
      { limit: '100' },
      ListPaginationQueryDto,
    )) as ListPaginationQueryDto;
    expect(ok.limit).toBe(100);

    await expect(run({ limit: '101' }, ListPaginationQueryDto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects other parameters on the plain lists', async () => {
    await expect(
      run({ page: '1', sort: 'x' }, ListPaginationQueryDto),
    ).rejects.toThrow(BadRequestException);
  });
});
