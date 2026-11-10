import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// What a client may send as X-Request-Id: 1 to 128 letters, digits, dots,
// dashes, underscores and colons. That covers UUIDs and the usual trace id
// formats. Anything else (too long, spaces, quotes, control characters) is
// replaced with a fresh UUID instead of going into every log line as is.
const SANE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isSaneRequestId(value: string): boolean {
  return SANE_REQUEST_ID.test(value);
}

// The id for one request: the client's own if it looks sane, otherwise a new
// UUID. It goes back in the response header too, so the client and support
// can match a response to its log lines.
export function requestIdFor(req: IncomingMessage, res: ServerResponse): string {
  const sent = req.headers['x-request-id'];
  const id = typeof sent === 'string' && isSaneRequestId(sent) ? sent : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}
