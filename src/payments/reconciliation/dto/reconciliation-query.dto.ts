import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { WholeNumber } from '../../../pagination/pagination';

export enum ReconciliationStatusFilter {
  UNRESOLVED = 'unresolved',
  RESOLVED = 'resolved',
  ALL = 'all',
}

export const RECONCILIATION_DEFAULT_PAGE = 1;
export const RECONCILIATION_DEFAULT_LIMIT = 20;
export const RECONCILIATION_MAX_LIMIT = 100;
// Order ids are PostgreSQL integers; a larger number could not match anything
// and would make the database fail instead of answering with an empty list.
export const ORDER_ID_MAX = 2_147_483_647;

export class ReconciliationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: RECONCILIATION_DEFAULT_PAGE,
    description: '1-based page number.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = RECONCILIATION_DEFAULT_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: RECONCILIATION_MAX_LIMIT,
    default: RECONCILIATION_DEFAULT_LIMIT,
    description: `Page size. Values above ${RECONCILIATION_MAX_LIMIT} are rejected with 400, not clamped.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RECONCILIATION_MAX_LIMIT)
  limit: number = RECONCILIATION_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    enum: ReconciliationStatusFilter,
    default: ReconciliationStatusFilter.UNRESOLVED,
  })
  @IsOptional()
  @IsEnum(ReconciliationStatusFilter)
  status: ReconciliationStatusFilter = ReconciliationStatusFilter.UNRESOLVED;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ORDER_ID_MAX,
    description:
      'Only the events of this order. An order that does not exist (or has no events) gives an empty list, not an error. Works together with `status`, `page` and `limit`.',
  })
  @IsOptional()
  @WholeNumber()
  @IsInt({ message: 'orderId must be a whole number of 1 or more' })
  @Min(1, { message: 'orderId must be a whole number of 1 or more' })
  @Max(ORDER_ID_MAX, {
    message: `orderId must not be greater than ${ORDER_ID_MAX}`,
  })
  orderId?: number;
}
