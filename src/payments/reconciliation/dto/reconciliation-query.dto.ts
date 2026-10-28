import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum ReconciliationStatusFilter {
  UNRESOLVED = 'unresolved',
  RESOLVED = 'resolved',
  ALL = 'all',
}

export const RECONCILIATION_DEFAULT_PAGE = 1;
export const RECONCILIATION_DEFAULT_LIMIT = 20;
export const RECONCILIATION_MAX_LIMIT = 100;

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
}
