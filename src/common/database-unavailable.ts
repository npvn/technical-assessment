import { DB_CONNECT_FAILED, DB_CONNECTION_LOST } from '../db/database.js';

// Errors that mean "the database isn't there right now". It is down,
// restarting or failing over, it has no connections left, or it was too slow
// to answer. None of that is a bug in the request or in the code, and the
// same request may well work a second later. The problem filter answers these
// with 503 and Retry-After instead of 500, and the booking metrics count them
// on their own.
//
// Only the code on the error is looked at, never the message text. pg puts
// the SQLSTATE in `code`, Node puts its system error code there (also on the
// AggregateError it throws when "localhost" has two addresses and both
// refuse), and Kysely passes both on as they are. pg gives no code when a
// pool connect fails or when a connection dies under a query, so database.ts
// adds our own: DB_CONNECT_FAILED for the first, DB_CONNECTION_LOST for the
// second. Both are 503s here, no message is ever matched.
//
// What that rests on: DB_CONNECTION_LOST is only set once pg has emitted
// 'error' on the client, which pg 8 does before it fails the pending query.
// A pg upgrade that changed that order would turn these back into 500s, and
// the AC-34 "ends a session in the middle of a booking" e2e tests would show it.

// 57P01 admin shutdown (a restart or failover), 57P02 crash shutdown, 57P03
// cannot connect now (still starting up), 53300 too many connections, 57014
// statement timeout. Then the ones that mean "busy right now, try again":
// 55P03 lock timeout (someone holds a lock, a migration say), 40P01 deadlock
// and 40001 serialization failure. The booking loop catches its own 57014,
// 55P03, 40P01 and 40001 first and answers BOOKING_CONTENDED or retries, so
// these are for the queries outside the loop.
const SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300', '57014', '55P03', '40P01', '40001']);

// Class 08 is "connection exception", every code in it starts with 08.
const CONNECTION_EXCEPTION = /^08[0-9A-Z]{3}$/;

// The network between the app and the database.
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export function isDatabaseUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) return false;
  return (
    code === DB_CONNECT_FAILED ||
    code === DB_CONNECTION_LOST ||
    SQLSTATES.has(code) ||
    CONNECTION_EXCEPTION.test(code) ||
    NETWORK_CODES.has(code)
  );
}

// The string in `code`, if the error has one.
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
