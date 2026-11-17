import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WholeNumber } from '../../pagination/pagination';
import {
  DEFAULT_ANALYTICS_TIMEZONE,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  TOP_LIMIT_DEFAULT,
  TOP_LIMIT_MAX,
} from '../analytics.constants';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a calendar date in the form YYYY-MM-DD';

// Shared by every analytics endpoint. Whether the dates are real, in order and
// within the maximum length is checked together by resolveAnalyticsRange.
export class AnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-19',
    description: `First day of the range (YYYY-MM-DD), included, in \`timezone\`. Default: ${DEFAULT_RANGE_DAYS - 1} days before \`to\`.`,
  })
  @IsOptional()
  @IsString({ message: `from ${DATE_MESSAGE}` })
  @Matches(DATE_FORMAT, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-17',
    description: `Last day of the range (YYYY-MM-DD), included, in \`timezone\`. Default: today in \`timezone\`. The range is at most ${MAX_RANGE_DAYS} days (both days included) and \`from\` may not be after \`to\`.`,
  })
  @IsOptional()
  @IsString({ message: `to ${DATE_MESSAGE}` })
  @Matches(DATE_FORMAT, { message: `to ${DATE_MESSAGE}` })
  to?: string;

  @ApiPropertyOptional({
    example: DEFAULT_ANALYTICS_TIMEZONE,
    default: DEFAULT_ANALYTICS_TIMEZONE,
    description:
      'IANA time zone that decides where a day starts and ends, for the range and for day buckets. Names such as Asia/Ho_Chi_Minh or UTC; offsets such as +07:00 are refused.',
  })
  @IsOptional()
  @IsString({ message: 'timezone must be an IANA time zone name' })
  @MaxLength(64, { message: 'timezone must be an IANA time zone name' })
  timezone?: string;
}

export class TopProductsQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: TOP_LIMIT_MAX,
    default: TOP_LIMIT_DEFAULT,
    description: `How many products, and how many categories, to return. Values above ${TOP_LIMIT_MAX} are rejected with 400, not clamped.`,
  })
  @IsOptional()
  @WholeNumber()
  @IsInt({ message: 'limit must be a whole number of 1 or more' })
  @Min(1, { message: 'limit must be a whole number of 1 or more' })
  @Max(TOP_LIMIT_MAX, {
    message: `limit must not be greater than ${TOP_LIMIT_MAX}`,
  })
  limit?: number;
}
