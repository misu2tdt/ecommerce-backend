import { ArgumentsHost } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { QueryFailedError } from 'typeorm';
import { DatabaseRangeFilter } from './database-range.filter';

describe('DatabaseRangeFilter', () => {
  const run = (code: string | undefined) => {
    const adapter = {
      reply: jest.fn(),
      isHeadersSent: jest.fn().mockReturnValue(false),
    };
    const filter = new DatabaseRangeFilter(adapter as never);
    // The arguments of an HTTP handler: request, response, next.
    const host = new ExecutionContextHost([
      {},
      {},
      jest.fn(),
    ]) as unknown as ArgumentsHost;
    const error = new QueryFailedError('SELECT 1', [], { code } as never);
    filter.catch(error, host);
    return adapter.reply.mock.calls[0] as [
      unknown,
      { statusCode: number; message: string },
      number,
    ];
  };

  it.each(['22003', '22P02'])(
    'answers 400 for a value the column can not hold (%s)',
    (code) => {
      const [, body, status] = run(code);
      expect(status).toBe(400);
      expect(body).toMatchObject({
        statusCode: 400,
        message: 'A number or value is out of range',
      });
    },
  );

  it.each(['23505', '40P01', undefined])(
    'leaves any other database error (%s) to the default 500',
    (code) => {
      const [, body, status] = run(code);
      expect(status).toBe(500);
      expect(body).toMatchObject({
        statusCode: 500,
        message: 'Internal server error',
      });
    },
  );
});
