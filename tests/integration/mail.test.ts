import { Readable } from 'node:stream';
import { SMTPServer } from 'smtp-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers';

const harnesses: TestHarness[] = [];
const servers: SMTPServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function storageRoot() { const directory = mkdtempSync(join(tmpdir(), 'storeweave-mail-')); directories.push(directory); return directory; }

async function smtpSink() {
  const messages: string[] = [];
  const server = new SMTPServer({ disabledCommands: ['STARTTLS', 'AUTH'], onData(stream, _session, callback) {
    stream.on('data', chunk => { messages.push(chunk.toString('utf8')); });
    stream.on('end', callback);
  } });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP sink did not expose a TCP port');
  return { port: address.port, messages };
}

describe('base mail capability', () => {
  it('durably snapshots an escaped localized template, streams an attachment, and sends it through its job', async () => {
    const sink = await smtpSink();
    const harness = await createHarness({ storageRoot: storageRoot(), mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: sink.port } } });
    harnesses.push(harness);
    const stored = await harness.runtime.storage.forNamespace('mail-fixture').upload({ ownerActorId: 'test:admin', visibility: 'private',
      originalName: 'invoice.txt', contentType: 'text/plain', stream: Readable.from('attachment payload'),
    });
    const initial = await harness.runtime.database.transaction(tx => harness.runtime.mail.queue(tx, {
      reference: 'receipt:42', to: [{ email: 'buyer@example.test', name: 'Buyer' }], locale: 'zh-TW',
      template: { id: 'receipt', version: 3, subject: 'Receipt {orderNumber}', html: '<p>Hi {name}</p>', text: 'Hi {name}',
        translations: { zh: { subject: '收據 {orderNumber}', html: '<p>您好 {name}</p>', text: '您好 {name}' } } },
      variables: { name: '<buyer>', orderNumber: 'SW-42' }, attachments: [{ namespace: 'mail-fixture', id: stored.id }],
    }));
    expect(initial.status).toBe('pending');
    await harness.worker.drain();
    const result = await harness.runtime.mail.diagnosticByReference('receipt:42');
    expect(result).toMatchObject({ status: 'accepted', template: { id: 'receipt', version: 3 } });
    const snapshot = await harness.runtime.database.pool.query<{ html: string }>('SELECT html FROM public.platform_mail_messages WHERE reference = $1', ['receipt:42']);
    expect(snapshot.rows[0].html).toBe('<p>您好 &lt;buyer&gt;</p>');
    expect(sink.messages.join('')).toContain('invoice.txt');
  });

  it('rejects a reused reference when its immutable mail content changes', async () => {
    const sink = await smtpSink();
    const harness = await createHarness({ storageRoot: storageRoot(), mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: sink.port } } });
    harnesses.push(harness);
    const request = { reference: 'same-reference', to: [{ email: 'buyer@example.test' }], template: { id: 'test', version: 1, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' } };
    await harness.runtime.database.transaction(tx => harness.runtime.mail.queue(tx, request));
    await expect(harness.runtime.database.transaction(tx => harness.runtime.mail.queue(tx, { ...request, to: [{ email: 'other@example.test' }] }))).rejects.toThrow('different immutable content');
  });

  it('records a missing streamed attachment as a permanent, operator-visible rejection', async () => {
    const sink = await smtpSink();
    const harness = await createHarness({ storageRoot: storageRoot(), mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: sink.port } } });
    harnesses.push(harness);
    await harness.runtime.database.transaction(tx => harness.runtime.mail.queue(tx, {
      reference: 'missing-attachment', to: [{ email: 'buyer@example.test' }], template: { id: 'test', version: 1, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' },
      attachments: [{ namespace: 'mail-fixture', id: '00000000-0000-4000-8000-000000000001' }],
    }));
    const drained = await harness.worker.drain();
    expect(drained.jobsFailed).toBe(1);
    const job = await harness.runtime.database.pool.query<{ last_error: string | null }>('SELECT last_error FROM public.platform_jobs WHERE type = $1', ['platform.mail.send']);
    expect(job.rows[0].last_error).toContain('Mail attachment is unavailable');
    await expect(harness.runtime.mail.diagnosticByReference('missing-attachment')).resolves.toMatchObject({ status: 'rejected', diagnosticKind: 'permanent' });
    expect(sink.messages).toEqual([]);
  });

  it('does not replay an unknown SMTP result when the same immediate reference is submitted again', async () => {
    let dataCalls = 0;
    const server = new SMTPServer({ disabledCommands: ['STARTTLS', 'AUTH'], onData(stream) { dataCalls += 1; stream.resume(); } });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('SMTP sink did not expose a TCP port');
    const harness = await createHarness({ storageRoot: storageRoot(), mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: address.port, socketTimeoutMs: 500 } } });
    harnesses.push(harness);
    const request = { reference: 'unknown-once', to: [{ email: 'buyer@example.test' }], template: { id: 'test', version: 1, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' } };
    await expect(harness.runtime.mail.sendNow(request)).resolves.toMatchObject({ status: 'unknown' });
    await expect(harness.runtime.mail.sendNow(request)).resolves.toMatchObject({ status: 'unknown' });
    expect(dataCalls).toBe(1);
  });

  it('retries a dead-lettered explicit recipient rejection with the same durable message', async () => {
    let rejectRecipient = true;
    let dataCalls = 0;
    const server = new SMTPServer({ disabledCommands: ['STARTTLS', 'AUTH'],
      onRcptTo(_address, _session, callback) {
        if (rejectRecipient) return callback(Object.assign(new Error('recipient temporarily unavailable'), { responseCode: 550 }));
        callback();
      },
      onData(stream, _session, callback) {
        dataCalls += 1;
        stream.resume();
        stream.on('end', callback);
      },
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('SMTP sink did not expose a TCP port');
    const harness = await createHarness({ storageRoot: storageRoot(), mail: { transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: address.port } } });
    harnesses.push(harness);
    await harness.runtime.mail.enqueue({
      reference: 'retry-rejected', to: [{ email: 'buyer@example.test' }],
      template: { id: 'test', version: 1, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' },
    });
    expect((await harness.worker.drain()).jobsFailed).toBe(1);
    const job = await harness.runtime.database.pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM public.platform_jobs WHERE type = $1', ['platform.mail.send'],
    );
    expect(job.rows).toEqual([{ id: expect.any(String), status: 'dead' }]);
    await expect(harness.runtime.mail.diagnosticByReference('retry-rejected')).resolves.toMatchObject({ status: 'rejected', attempts: 1 });
    rejectRecipient = false;
    await harness.runtime.jobs.retryDead(harness.runtime.database.db, job.rows[0]!.id);
    expect((await harness.worker.drain()).jobsProcessed).toBe(1);
    await expect(harness.runtime.mail.diagnosticByReference('retry-rejected')).resolves.toMatchObject({ status: 'accepted', attempts: 2 });
    expect(dataCalls).toBe(1);
  });
});
