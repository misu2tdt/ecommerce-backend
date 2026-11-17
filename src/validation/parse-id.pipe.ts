import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { INT_MAX } from './limits';

// Like ParseIntPipe for a path parameter that is an id, but a number that does
// not fit a PostgreSQL integer is a 400 here instead of a database error. Values
// that fit behave as before (a number that matches nothing is still a 404 from
// the service).
//
// With the global ValidationPipe (transform: true) a path parameter declared as
// a number has already been turned into one when this pipe runs ("abc" has become
// NaN), so it takes a number as well as a string.
@Injectable()
export class ParseIdPipe implements PipeTransform<string | number, number> {
  transform(value: string | number, metadata: ArgumentMetadata): number {
    const name = metadata.data ?? 'id';
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^-?\d+$/.test(text.trim())) {
      throw new BadRequestException(`${name} must be a whole number`);
    }
    const id = Number(text);
    if (!Number.isSafeInteger(id) || Math.abs(id) > INT_MAX) {
      throw new BadRequestException(
        `${name} must not be greater than ${INT_MAX}`,
      );
    }
    return id;
  }
}
