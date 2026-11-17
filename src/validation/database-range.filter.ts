import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

// PostgreSQL codes for a value the column can not hold:
//   22003 numeric_value_out_of_range, 22P02 invalid_text_representation.
const REFUSED_VALUE_CODES = new Set(['22003', '22P02']);

// The last line of defence. Inputs are limited where they enter (the DTOs and
// ParseIdPipe), so a number that does not fit a column should never get as far as
// the database. If one does, because a limit was missed, the client gets a 400
// instead of a 500. Every other database error is left to Nest's default answer.
@Catch(QueryFailedError)
export class DatabaseRangeFilter extends BaseExceptionFilter {
  override catch(exception: QueryFailedError, host: ArgumentsHost): void {
    const code = (exception.driverError as { code?: string } | undefined)?.code;
    const mapped: HttpException | QueryFailedError =
      code && REFUSED_VALUE_CODES.has(code)
        ? new BadRequestException('A number or value is out of range')
        : exception;
    super.catch(mapped, host);
  }
}
