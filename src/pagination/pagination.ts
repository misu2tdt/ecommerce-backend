import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Response } from 'express';

// Opt-in paging for list endpoints. A client that sends neither `page` nor
// `limit` gets the whole list as before (older clients keep working). A client
// that sends either one gets one page: the body is still a plain array, and the
// totals travel in response headers.

export const PAGINATION_HEADERS = [
  'X-Total-Count',
  'X-Total-Pages',
  'X-Page',
  'X-Limit',
] as const;

// Documents the headers of a paged response in Swagger.
export const PAGINATION_HEADER_DOCS = {
  'X-Total-Count': {
    description: 'Number of rows matching the request, over all pages.',
    schema: { type: 'integer' },
  },
  'X-Total-Pages': {
    description: 'Number of pages at this page size (0 when nothing matches).',
    schema: { type: 'integer' },
  },
  'X-Page': { description: 'The page returned.', schema: { type: 'integer' } },
  'X-Limit': {
    description: 'The page size used.',
    schema: { type: 'integer' },
  },
};

export interface PageSize {
  // Used when paging is on but `limit` is left out.
  default: number;
  // Larger values are rejected with 400, never silently reduced.
  max: number;
}

// Public catalog pages: small pages of product cards.
export const CATALOG_PAGE_SIZE: PageSize = { default: 12, max: 48 };
// Order history and admin tables, like the reconciliation list.
export const LIST_PAGE_SIZE: PageSize = { default: 20, max: 100 };

// Far beyond any real catalog; keeps the row offset a small, safe number.
export const MAX_PAGE = 100_000;

export interface Paging {
  page: number;
  limit: number;
  offset: number;
}

export interface PagingInput {
  page?: number;
  limit?: number;
}

// null means the client did not ask for paging: return everything.
export function resolvePaging(
  input: PagingInput,
  size: PageSize,
): Paging | null {
  if (input.page === undefined && input.limit === undefined) return null;
  const page = input.page ?? 1;
  const limit = input.limit ?? size.default;
  return { page, limit, offset: (page - 1) * limit };
}

export function paginationHeaders(
  total: number,
  paging: Pick<Paging, 'page' | 'limit'>,
): Record<(typeof PAGINATION_HEADERS)[number], string> {
  return {
    'X-Total-Count': String(total),
    'X-Total-Pages': String(Math.ceil(total / paging.limit)),
    'X-Page': String(paging.page),
    'X-Limit': String(paging.limit),
  };
}

export function applyPaginationHeaders(
  response: Pick<Response, 'setHeader'>,
  total: number,
  paging: Pick<Paging, 'page' | 'limit'>,
): void {
  for (const [name, value] of Object.entries(
    paginationHeaders(total, paging),
  )) {
    response.setHeader(name, value);
  }
}

// Answers a list request: everything when the client did not ask for paging,
// otherwise one page with the totals in the response headers.
export async function listWithPaging<T>(
  response: Pick<Response, 'setHeader'>,
  query: PagingInput,
  size: PageSize,
  loadAll: () => Promise<T[]>,
  loadPage: (paging: Paging) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const paging = resolvePaging(query, size);
  if (!paging) return loadAll();
  const { items, total } = await loadPage(paging);
  applyPaginationHeaders(response, total, paging);
  return items;
}

// Only plain digits count as a number: "1e1", "0x10", "1.5", " 2", "" and
// repeated parameters become NaN, which the integer check then rejects.
export const WholeNumber = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') return value;
    return typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : NaN;
  });

export function PageParam() {
  return applyDecorators(
    ApiPropertyOptional({
      minimum: 1,
      maximum: MAX_PAGE,
      description:
        '1-based page number. Sending `page` or `limit` turns paging on; totals are returned in the X-Total-Count, X-Total-Pages, X-Page and X-Limit headers.',
    }),
    IsOptional(),
    WholeNumber(),
    IsInt({ message: 'page must be a whole number of 1 or more' }),
    Min(1, { message: 'page must be a whole number of 1 or more' }),
    Max(MAX_PAGE, { message: `page must not be greater than ${MAX_PAGE}` }),
  );
}

export function LimitParam(size: PageSize) {
  return applyDecorators(
    ApiPropertyOptional({
      minimum: 1,
      maximum: size.max,
      default: size.default,
      description: `Page size when paging is on. Values above ${size.max} are rejected with 400, not clamped.`,
    }),
    IsOptional(),
    WholeNumber(),
    IsInt({ message: 'limit must be a whole number of 1 or more' }),
    Min(1, { message: 'limit must be a whole number of 1 or more' }),
    Max(size.max, { message: `limit must not be greater than ${size.max}` }),
  );
}

// Query for the lists that have no other parameters.
export class ListPaginationQueryDto {
  @PageParam()
  page?: number;

  @LimitParam(LIST_PAGE_SIZE)
  limit?: number;
}
