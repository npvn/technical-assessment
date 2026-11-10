import { DB_CONNECT_FAILED } from '../db/database.js';

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
// refuse), and Kysely passes both on as they are. A failed pool connect with
// no code of its own gets DB_CONNECT_FAILED (see database.ts).
//
// Known gap: a connection that dies in the middle of a query gives
// "Connection terminated unexpectedly" with no code, so it is still a 500.
// pg doesn't tell it apart from other errors, and matching the message would
// be guessing.

// 57P01 admin shutdown (a restart or failover), 57P02 crash shutdown, 57P03
// cannot connect now (still starting up), 53300 too many connections, 57014
// statement timeout. The booking loop catches its own 57014 first and answers
// BOOKING_CONTENDED, so this one is for the queries outside the loop.
const SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300', '57014']);

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
