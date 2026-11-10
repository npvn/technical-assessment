import { createServer, type Server, type Socket } from 'node:net';
import { sql } from 'kysely';
import { createDatabase } from '../../../src/db/database.js';

// Getting a connection from the pool can fail in ways pg gives no code to,
// a connect timeout above all. Every such error is a connection failure by
// definition, so the pool gives it the code DB_CONNECT_FAILED, and the
// problem filter can answer 503 from the code alone. No Postgres needed
// here, a local socket stands in for the database host.

let silent: Server;
let silentPort: number;
const sockets: Socket[] = [];

// A host that accepts the connection and then never says a word, like one
// that drops packets after the handshake
beforeAll(async () => {
  silent = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  silentPort = (silent.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function database(port: number) {
  return createDatabase({
    url: `postgres://user:pass@127.0.0.1:${port}/scheduler`,
    poolSize: 1,
    statementTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    connectTimeoutMs: 200,
  });
}

// Runs a query and hands back what it failed with, or a note if it didn't
// fail within 2 s (so a missing connect timeout can't hang the test)
async function failure(db: ReturnType<typeof createDatabase>): Promise<unknown> {
  try {
    return await Promise.race([
      sql`SELECT 1`.execute(db).then(() => 'no error'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2_000)),
    ]);
  } catch (error) {
    return error;
  } finally {
    // Not awaited: with a connect still waiting, destroy would wait too.
    // afterAll closes the sockets, which ends it.
    void db.destroy().catch(() => {});
  }
}

describe('getting a connection', () => {
  it('a connect timeout gets the code DB_CONNECT_FAILED', async () => {
    const error = await failure(database(silentPort));

    expect(error).toMatchObject({ code: 'DB_CONNECT_FAILED' });
  });

  it('an error that already has a code keeps it (ECONNREFUSED)', async () => {
    const error = await failure(database(await closedPort()));

    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
  });
});
