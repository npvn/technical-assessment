import type { ArgumentsHost } from '@nestjs/common';
import { ProblemFilter } from '../../../src/common/problem.filter.js';

// The exception filter on its own, with a fake response. The e2e tests show
// the same thing through the real app for one case each, this is the table.

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  contentType = '';
  body = '';

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  set(headers: Record<string, string>): this {
    Object.assign(this.headers, headers);
    return this;
  }

  type(value: string): this {
    this.contentType = value;
    return this;
  }

  send(body: string): this {
    this.body = body;
    return this;
  }
}

function answer(exception: unknown): FakeResponse {
  const res = new FakeResponse();
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return res;
}

// What pg and Node put on the error, a SQLSTATE or a system error code
const withCode = (code: string, message = `failed with ${code} at 10.0.0.7:5432`) =>
  Object.assign(new Error(message), { code });

describe('the database is not there right now', () => {
  it.each([
    ['57P01', 'admin shutdown, a restart or a failover'],
    ['57P02', 'crash shutdown'],
    ['57P03', 'cannot connect now, the server is starting up'],
    ['53300', 'too many connections'],
    ['57014', 'a statement timeout outside the booking loop'],
    ['08006', 'connection failure'],
    ['08001', 'the client could not connect'],
    ['08003', 'the connection does not exist'],
    ['ECONNREFUSED', 'nothing listening on the port'],
    ['ECONNRESET', 'the connection was reset'],
    ['ETIMEDOUT', 'the network gave up'],
    ['EHOSTUNREACH', 'no route to the host'],
    ['ENETUNREACH', 'no route to the network'],
    ['ENOTFOUND', 'the host name did not resolve'],
    ['EAI_AGAIN', 'the name lookup failed for now'],
  ])('%s (%s) is 503 SERVICE_UNAVAILABLE with Retry-After', (code) => {
    const res = answer(withCode(code));

    expect(res.statusCode).toBe(503);
    expect(res.headers).toEqual({ 'Retry-After': '1' });
    expect(res.contentType).toBe('application/problem+json');
    expect(JSON.parse(res.body)).toEqual({
      type: 'about:blank',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      title: expect.any(String),
      detail: expect.any(String),
    });
  });

  it('says nothing about what failed or where', () => {
    const res = answer(withCode('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.7:5432'));

    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('10.0.0.7');
  });
});

describe('everything else unexpected is still a 500', () => {
  it.each([
    ['a plain error', new Error('kaboom')],
    ['a unique violation', withCode('23505')],
    ['an exclusion violation', withCode('23P01')],
    ['a deadlock the loop did not catch', withCode('40P01')],
    ['a code that only looks like a class 08 one', withCode('X08006')],
    ['a code that is not a string', Object.assign(new Error('odd'), { code: 57 })],
    ['something that is not an Error', 'just a string'],
  ])('%s is 500 INTERNAL_ERROR with no Retry-After', (_why, exception) => {
    const res = answer(exception);

    expect(res.statusCode).toBe(500);
    expect(res.headers).toEqual({});
    expect(JSON.parse(res.body)).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});
