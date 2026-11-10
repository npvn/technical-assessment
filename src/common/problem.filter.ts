import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { errorCode, isDatabaseUnavailable } from './database-unavailable.js';
import { ProblemException, validationProblem, type Problem } from './problem.js';

// The one place errors leave the API, always as application/problem+json
// with a stable code (RFC 9457). Clients switch on `code`. `type` is
// about:blank, the RFC default, because the code already carries the meaning.
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { problem, headers } = this.toProblem(exception);
    const res = host.switchToHttp().getResponse<Response>();
    res
      .status(problem.status)
      .set(headers)
      .type('application/problem+json')
      .send(JSON.stringify({ type: 'about:blank', ...problem }));
  }

  private toProblem(exception: unknown): { problem: Problem; headers: Record<string, string> } {
    if (exception instanceof ProblemException) {
      return { problem: exception.problem, headers: exception.headers };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // A body that isn't JSON at all ends up here as a plain 400
      if (status === 400) {
        return { problem: validationProblem([]).problem, headers: {} };
      }
      if (status === 404) {
        return {
          problem: {
            status,
            code: 'NOT_FOUND',
            title: 'Not found',
            detail: 'There is nothing at this path.',
          },
          headers: {},
        };
      }
      // Anything else Nest or Express raises (413, 415 and so on) keeps its
      // status, and the code is the status name, like PAYLOAD_TOO_LARGE.
      const name = HttpStatus[status] ?? 'HTTP_ERROR';
      return {
        problem: { status, code: name, title: exception.message, detail: exception.message },
        headers: {},
      };
    }

    // The database is down, restarting or too slow right now. That's "try
    // again shortly", not a bug. Only the code goes in the log, the message
    // can carry the host and port.
    if (isDatabaseUnavailable(exception)) {
      this.logger.warn(`database unavailable, code ${errorCode(exception)}`);
      return {
        problem: {
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          title: 'Service unavailable',
          detail: 'The service cannot answer right now. Try again shortly.',
        },
        headers: { 'Retry-After': '1' },
      };
    }

    // A bug or anything else unexpected. The real error goes to the log, the
    // client gets nothing that could leak internals.
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    return {
      problem: {
        status: 500,
        code: 'INTERNAL_ERROR',
        title: 'Internal error',
        detail: 'Something went wrong on our side.',
      },
      headers: {},
    };
  }
}
