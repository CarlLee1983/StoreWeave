import type { PoolClient } from 'pg';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { Database } from '../src/client';
import { DatabaseOperationTimeoutError } from '@storeweave/contracts';

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function within<T>(promise: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function client() {
  return {
    query: vi.fn(async () => undefined),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function database(connect: () => Promise<PoolClient>) {
  const db = new Database({ url: 'postgres://unused/unused' });
  (db.pool as unknown as { connect: () => Promise<PoolClient> }).connect = connect;
  return db;
}

async function handshakeBlackhole() {
  let connected!: () => void;
  let closed!: () => void;
  const connection = new Promise<void>(resolve => { connected = resolve; });
  const socketClosed = new Promise<void>(resolve => { closed = resolve; });
  let socket: Socket | undefined;
  const server = createServer(accepted => {
    socket = accepted;
    connected();
    accepted.resume(); // Consume startup bytes while deliberately withholding every server response.
    accepted.once('end', closed);
    accepted.once('close', closed);
    // Intentionally never answer the PostgreSQL startup packet.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener address');
  return { server, connection, socketClosed, socket: () => socket, port: address.port };
}

describe('Database.boundedTransaction', () => {
  it('uses one absolute deadline across delayed acquisition and a hung callback', async () => {
    const leased = client();
    const db = database(async () => { await delay(30); return leased; });
    const started = Date.now();
    await expect(db.boundedTransaction(70, 'absolute-deadline', async () => new Promise<never>(() => {})))
      .rejects.toBeInstanceOf(DatabaseOperationTimeoutError);
    expect(Date.now() - started).toBeLessThan(90);
    expect(leased.release).toHaveBeenCalledWith(expect.any(DatabaseOperationTimeoutError));
    await db.close();
  });

  it('discards a client delivered after pool starvation has timed out', async () => {
    let deliver!: (value: PoolClient) => void;
    const db = database(() => new Promise(resolve => { deliver = resolve; }));
    await expect(db.boundedTransaction(20, 'pool-starvation', async () => undefined))
      .rejects.toBeInstanceOf(DatabaseOperationTimeoutError);
    const late = client();
    deliver(late);
    await delay(0);
    expect(late.release).toHaveBeenCalledWith(expect.any(DatabaseOperationTimeoutError));
    await db.close();
  });

  it('bounds a connection attempt that never resolves', async () => {
    const db = database(() => new Promise<PoolClient>(() => {}));
    const started = Date.now();
    await expect(db.boundedTransaction(20, 'connect-hang', async () => undefined))
      .rejects.toBeInstanceOf(DatabaseOperationTimeoutError);
    expect(Date.now() - started).toBeLessThan(60);
    await db.close();
  });

  it('uses node-postgres connection timeout to close a real stalled handshake socket', async () => {
    const blackhole = await handshakeBlackhole();
    const db = new Database({ url: `postgres://127.0.0.1:${blackhole.port}/unused`, connectionTimeoutMs: 25 });
    try {
      expect((db.pool as unknown as { options: { connectionTimeoutMillis: number } }).options.connectionTimeoutMillis).toBe(25);
      const connect = db.pool.connect();
      await blackhole.connection;
      const outcome = await Promise.race([
        connect.then(
          () => ({ kind: 'connected' as const }),
          error => ({ kind: 'driver-error' as const, error }),
        ),
        delay(250).then(() => ({ kind: 'test-deadline' as const })),
      ]);
      expect(outcome.kind).toBe('driver-error');
      if (outcome.kind === 'driver-error') expect((outcome.error as Error).message).toMatch(/timeout|terminated/i);
      await within(blackhole.socketClosed, 250, 'stalled handshake socket close');
    } finally {
      blackhole.socket()?.destroy();
      await db.close().catch(() => undefined);
      await new Promise<void>(resolve => blackhole.server.close(() => resolve()));
    }
  });

  it('discards a client with a hung query instead of returning an open transaction to the pool', async () => {
    const leased = client();
    (leased.query as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(() => new Promise(() => {}));
    const db = database(async () => leased);
    await expect(db.boundedTransaction(20, 'query-hang', async () => undefined))
      .rejects.toBeInstanceOf(DatabaseOperationTimeoutError);
    expect(leased.release).toHaveBeenCalledWith(expect.any(DatabaseOperationTimeoutError));
    await db.close();
  });
});
