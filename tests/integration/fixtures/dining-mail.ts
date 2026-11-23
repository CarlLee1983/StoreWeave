import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { createRuntime, Worker, type Runtime } from '@storeweave/kernel';
import { SMTPServer } from 'smtp-server';
import { afterEach } from 'vitest';
import { createDiningReservationModule } from '../../../packages/dining/reservation/src/module';
import { createTestDatabase, testSecretProvider } from '../helpers';

export function diningMailFixture(id: string) {
  const runtimes: Runtime[] = [];
  const servers: SMTPServer[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  return async function start() {
    const smtp: { outcome: 'accept' | 'reject' | 'unknown'; recipients: string[] } = { outcome: 'accept', recipients: [] };
    const server = new SMTPServer({
      disabledCommands: ['AUTH', 'STARTTLS'],
      onRcptTo(address, _session, callback) {
        smtp.recipients.push(address.address);
        const error = smtp.outcome === 'reject'
          ? Object.assign(new Error('Recipient rejected'), { responseCode: 550 })
          : null;
        callback(error);
      },
      onData(stream, _session, callback) {
        stream.resume();
        stream.on('end', () => { if (smtp.outcome !== 'unknown') callback(); });
      },
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('SMTP test server has no TCP port');

    const runtime = await createRuntime({
      release: { id, version: '1.0.0', buildManifestChecksum: `sha256:${'6'.repeat(64)}` },
      roles: BASE_ROLES,
      config: baseConfigSchema.parse({
        version: 1, store: { id, name: 'Dining Notifications Test' },
        database: { url: await createTestDatabase() }, logging: { level: 'error' },
        security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
        mail: {
          transport: 'smtp', from: 'dining@example.test',
          smtp: { host: '127.0.0.1', port: address.port, socketTimeoutMs: 500 },
        },
      }),
      secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 6).toString('base64url') }),
      logger: noopLogger, availableExtensions: {}, modules: [createDiningReservationModule({
        source: { limit: 10, windowMinutes: 60 },
        recipient: { limit: 10, windowMinutes: 60 },
        piiRetentionDays: 30, identityKey: Buffer.alloc(32, 7),
      })],
    });
    runtimes.push(runtime);
    await runtime.migrate();
    const worker = new Worker(runtime, { workerId: id });
    return { runtime, smtp, worker };
  };
}
