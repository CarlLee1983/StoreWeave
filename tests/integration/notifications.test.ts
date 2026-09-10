import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfTokenFor } from '@storeweave/identity';
import { Worker, type Runtime } from '@storeweave/kernel';
import type { DeliveryEvidenceDto } from '@storeweave/notifications';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { ADMIN_ACTOR, createTestDatabase } from './helpers';

/** Base has no test harness worker; drain until nothing is left to run. */
async function settle(runtime: Runtime): Promise<void> {
  const worker = new Worker(runtime, { pollIntervalMs: 50, workerId: `notifications-${randomUUID().slice(0, 8)}` });
  let quiet = 0;
  for (let round = 0; round < 20; round += 1) {
    const result = await worker.drain();
    const idle = result.jobsProcessed === 0 && result.jobsFailed === 0 && result.relayed === 0;
    if (idle && ++quiet >= 2) return;
    if (!idle) quiet = 0;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const runtimes: Runtime[] = [];
const servers: SMTPServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function smtpSink(options: { rejectAll?: boolean } = {}) {
  const messages: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS', 'AUTH'],
    onRcptTo(_address, _session, callback) {
      callback(options.rejectAll ? new Error('550 recipient rejected') : null);
    },
    onData(stream, _session, callback) {
      stream.on('data', chunk => { messages.push(chunk.toString('utf8')); });
      stream.on('end', callback);
    },
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP sink did not expose a TCP port');
  return { port: address.port, messages };
}

async function baseRuntime(mail?: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-notifications-'));
  directories.push(directory);
  const config = join(directory, 'config.yaml');
  // 身分連結是簽發值，沒有金鑰的部署不會啟動（ADR 0042）。
  process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
  writeFileSync(config, JSON.stringify({
    version: 1, store: { id: 'notifications-test', name: 'Notifications Test' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
    storage: { localRoot: join(directory, 'storage') },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    ...(mail ? { mail } : {}),
  }));
  const result = await bootstrapRelease(baseRelease, { configPath: config, loggerName: 'notifications-test' });
  runtimes.push(result.runtime);
  await result.runtime.migrate();
  return result;
}

async function createOperator(runtime: Runtime, password: string) {
  const user = await runtime.commands.execute<{ id: string }>('platform.identity.createUser', {
    email: 'inbox@example.test', password, displayName: 'Inbox Owner', role: 'staff',
  }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  return { id: user.id, actorId: `user:${user.id}` };
}

const template = {
  id: 'account.security-alert', version: 2,
  email: { subject: 'Security alert for {device}', html: '<p>New sign-in from {device}</p>', text: 'New sign-in from {device}',
    translations: { zh: { subject: '{device} 的登入通知', html: '<p>{device} 剛剛登入</p>', text: '{device} 剛剛登入' } } },
  inapp: { title: 'New sign-in', body: 'We saw a sign-in from {device}.',
    translations: { zh: { title: '有新的登入', body: '{device} 剛剛登入了你的帳號。' } } },
};

describe('base notification capability', () => {
  it('delivers one notification to both channels and keeps the in-app copy readable over HTTP', async () => {
    const sink = await smtpSink();
    const password = 'notifications-passphrase';
    const { runtime, loaded } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: sink.port } });
    const operator = await createOperator(runtime, password);

    const created = await runtime.notifications.dispatch({
      reference: 'security-alert:1', channels: ['email', 'inapp'], locale: 'zh-TW',
      recipient: { userId: operator.actorId, email: 'inbox@example.test', name: 'Inbox Owner' },
      template, variables: { device: 'Taipei laptop' },
    });
    expect(created.deliveries.map(delivery => [delivery.channel, delivery.status]))
      .toEqual([['email', 'pending'], ['inapp', 'sent']]);

    // 站內通知在交易提交的當下就已經投遞完成——收件匣那一列就是投遞本身。
    const app = await createReleaseServer({ runtime, httpAdapter, release: { version: baseRelease.version, configPath: loaded.sourcePath } });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'inbox@example.test', password } });
      const cookie = login.cookies.find(entry => entry.name === SESSION_COOKIE)!;
      const inbox = await app.inject({ url: '/api/v1/notifications?unreadOnly=true', cookies: { [SESSION_COOKIE]: cookie.value } });
      expect(inbox.statusCode).toBe(200);
      expect(inbox.json().data).toMatchObject({ total: 1, unread: 1 });
      const item = inbox.json().data.items[0] as { id: string; title: string; body: string; readAt: string | null };
      expect(item).toMatchObject({ title: '有新的登入', body: 'Taipei laptop 剛剛登入了你的帳號。', readAt: null });

      const read = await app.inject({
        method: 'POST', url: '/api/v1/notifications/read',
        headers: { 'x-csrf-token': csrfTokenFor(cookie.value), 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: cookie.value }, payload: { ids: [item.id] },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.updated).toBe(1);
      const afterRead = await app.inject({ url: '/api/v1/notifications?unreadOnly=true', cookies: { [SESSION_COOKIE]: cookie.value } });
      expect(afterRead.json().data).toMatchObject({ total: 0, unread: 0 });
    } finally { await app.close(); }

    // 信要等它自己的工作跑完；通道各自獨立正是這樣看得出來的。
    await settle(runtime);
    const evidence = await runtime.queries.execute<{ items: DeliveryEvidenceDto[] }>(
      'platform.notifications.listDeliveries', { reference: 'security-alert:1' }, { actor: ADMIN_ACTOR });
    // 收件人在證據上一律遮蔽；有地址就遮地址，沒有才落到帳號識別。
    expect(evidence.items.map(item => [item.channel, item.status, item.recipientMasked]).sort()).toEqual([
      ['email', 'sent', 'i***@example.test'],
      ['inapp', 'sent', 'i***@example.test'],
    ]);
    expect(sink.messages.join('')).toContain('=?UTF-8?');
  });

  it('records a rejected recipient without touching the in-app copy, and skips email when no transport is configured', async () => {
    const sink = await smtpSink({ rejectAll: true });
    const rejecting = await baseRuntime({ transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: sink.port } });
    const operator = await createOperator(rejecting.runtime, 'notifications-passphrase');
    await rejecting.runtime.notifications.dispatch({
      reference: 'security-alert:2', channels: ['email', 'inapp'],
      recipient: { userId: operator.actorId, email: 'inbox@example.test' },
      template, variables: { device: 'Taipei laptop' },
    });
    await settle(rejecting.runtime);
    const rejected = await rejecting.runtime.queries.execute<{ items: DeliveryEvidenceDto[] }>(
      'platform.notifications.listDeliveries', { reference: 'security-alert:2' }, { actor: ADMIN_ACTOR });
    const email = rejected.items.find(item => item.channel === 'email')!;
    // 一個通道退信不影響另一個，而錯誤訊息裡的地址一樣要遮。
    expect(email.status).toBe('failed');
    expect(email.attempts).toBeGreaterThanOrEqual(1);
    expect(email.lastError).not.toContain('inbox@example.test');
    expect(rejected.items.find(item => item.channel === 'inapp')!.status).toBe('sent');

    const disabled = await baseRuntime();
    const owner = await createOperator(disabled.runtime, 'notifications-passphrase');
    const created = await disabled.runtime.notifications.dispatch({
      reference: 'security-alert:3', channels: ['email', 'inapp'],
      recipient: { userId: owner.actorId, email: 'inbox@example.test' },
      template, variables: { device: 'Taipei laptop' },
    });
    // 沒有設定寄信管道是部署的決定，不是投遞失敗：不排工作，也不重試。
    expect(created.deliveries.map(delivery => [delivery.channel, delivery.status]))
      .toEqual([['email', 'skipped'], ['inapp', 'sent']]);
    const pending = await disabled.runtime.database.pool.query(
      "SELECT 1 FROM platform_jobs WHERE type = 'platform.notification.deliver'");
    expect(pending.rowCount).toBe(0);
  });

  it('treats one reference as one notification however many times it is sent', async () => {
    const sink = await smtpSink();
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test', smtp: { host: '127.0.0.1', port: sink.port } });
    const operator = await createOperator(runtime, 'notifications-passphrase');
    const request = {
      reference: 'security-alert:4', channels: ['email' as const, 'inapp' as const],
      recipient: { userId: operator.actorId, email: 'inbox@example.test' },
      template, variables: { device: 'Taipei laptop' },
    };
    const first = await runtime.notifications.dispatch(request);
    const second = await runtime.notifications.dispatch(request);
    expect(second.id).toBe(first.id);
    await settle(runtime);
    await settle(runtime);
    expect(sink.messages.filter(message => message.includes('Message-ID'))).toHaveLength(1);
    await expect(runtime.notifications.dispatch({ ...request, variables: { device: 'another laptop' } }))
      .rejects.toThrow(/different immutable content/);
  });
});
