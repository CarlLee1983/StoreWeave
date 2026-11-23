import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineCommand } from '@storeweave/contracts';
import { csrfTokenFor } from '@storeweave/identity';
import { Worker, type Runtime } from '@storeweave/kernel';
import { resendEmailInput, resendEmailOutput, type DeliveryEvidenceDto, type NotificationsPort } from '@storeweave/notifications';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { bootstrapRelease } from '../../packages/platform/release/src/bootstrap';
import { release as baseRelease } from '../../packages/releases/base/src/runtime';
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

async function smtpSink(options: { rejectAll?: boolean; withholdReceipt?: boolean } = {}) {
  const messages: string[] = [];
  const recipients: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS', 'AUTH'],
    onRcptTo(address, _session, callback) {
      recipients.push(address.address);
      callback(options.rejectAll ? new Error('550 recipient rejected') : null);
    },
    onData(stream, _session, callback) {
      stream.on('data', chunk => { messages.push(chunk.toString('utf8')); });
      stream.on('end', () => { if (!options.withholdReceipt) callback(); });
    },
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP sink did not expose a TCP port');
  return { port: address.port, messages, recipients };
}

async function baseRuntime(mail?: Record<string, unknown>, poolSize?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-notifications-'));
  directories.push(directory);
  const config = join(directory, 'config.yaml');
  // 身分連結是簽發值，沒有金鑰的部署不會啟動（ADR 0042）。
  process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
  writeFileSync(config, JSON.stringify({
    version: 1, store: { id: 'notifications-test', name: 'Notifications Test' },
    database: { url: await createTestDatabase(), poolSize }, logging: { level: 'error' }, extensions: [],
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    storage: { localRoot: join(directory, 'storage') },
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

const resendOperator = { id: 'user:resend-operator', type: 'user' as const, permissions: ['notifications:resend'] };

async function emailNotification(runtime: Runtime, reference: string) {
  const notification = await runtime.notifications.dispatch({
    reference, channels: ['email'], recipient: { email: 'private@example.test' },
    template, variables: { device: 'Taipei laptop' },
  });
  const deliveryId = notification.deliveries[0].id;
  const mailReference = `notification:${reference}:email`;
  return {
    deliveryId, mailReference,
    mail: () => runtime.mail.diagnosticByReference(mailReference),
    evidence: async () => (await runtime.notifications.evidenceByReference([reference])).get(reference)?.[0],
    audit: () => runtime.audit.list(runtime.database.db, { resourceType: 'notification_delivery', resourceId: deliveryId }),
    resend: (expectedAttempts: number, acknowledgeDuplicateRisk = false, operationId = randomUUID()) =>
      runtime.commands.execute('platform.notifications.resendEmail', {
        deliveryId, expectedAttempts, acknowledgeDuplicateRisk, operationId,
      }, { actor: resendOperator, idempotencyKey: operationId }),
  };
}

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

  it('requires an authorized, explicit acknowledgment before resending an unknown result', async () => {
    const behavior = { withholdReceipt: true };
    const sink = await smtpSink(behavior);
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test',
      smtp: { host: '127.0.0.1', port: sink.port, socketTimeoutMs: 250 } });
    const reference = 'security-alert:manual-unknown';
    const { deliveryId, evidence, mail: mailEvidence, audit } = await emailNotification(runtime, reference);
    await settle(runtime);
    expect(await evidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(await mailEvidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    behavior.withholdReceipt = false;
    await runtime.notifications.deliver(deliveryId);
    expect(sink.messages.filter(message => message.includes('Message-ID'))).toHaveLength(1);

    const operator = resendOperator;
    const input = { deliveryId, expectedAttempts: 1 };
    const resend = (actor: typeof ADMIN_ACTOR, acknowledgeDuplicateRisk?: boolean, idempotencyKey = randomUUID()) =>
      runtime.commands.execute('platform.notifications.resendEmail', { ...input, operationId: idempotencyKey, acknowledgeDuplicateRisk }, { actor, idempotencyKey });
    await expect(resend({ ...operator, permissions: ['mail:send'] }, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resend(operator)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await settle(runtime);
    expect(await evidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(await mailEvidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(await audit()).toEqual([]);
    expect(sink.messages.filter(message => message.includes('Message-ID'))).toHaveLength(1);

    const idempotencyKey = randomUUID();
    const requested = await resend(operator, true, idempotencyKey);
    await expect(resend({ ...operator, type: 'service' }, true, idempotencyKey)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resend(operator, true, idempotencyKey)).resolves.toEqual(requested);
    expect(await audit()).toEqual([]);
    await settle(runtime);
    await expect(resend(operator, true, idempotencyKey)).resolves.toEqual(requested);
    expect(await evidence()).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await mailEvidence()).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(sink.messages.filter(message => message.includes('Message-ID'))).toHaveLength(2);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: operator.id, actorType: 'user', occurredAt: expect.any(Date),
      action: 'notification.email_resent',
      payload: { previousStatus: 'unknown', status: 'sent', attempts: 2, acknowledgeDuplicateRisk: true },
    });
    expect(JSON.stringify(rows)).not.toContain('private@example.test');
  });

  it.each(['missing', 'rejected'])('does not automatically send unknown Notification mail when the Mail record is %s', async mailState => {
    const behavior = { withholdReceipt: true };
    const sink = await smtpSink(behavior);
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test',
      smtp: { host: '127.0.0.1', port: sink.port, socketTimeoutMs: 250 } });
    const notification = await emailNotification(runtime, 'security-alert:stale-unknown');
    await settle(runtime);
    expect(await notification.evidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(await notification.mail()).toMatchObject({ status: 'unknown', attempts: 1 });

    // Model a historical or independently changed Mail record while Notification still says unknown.
    if (mailState === 'missing') {
      await runtime.database.pool.query('DELETE FROM public.platform_mail_messages WHERE reference = $1', [notification.mailReference]);
    } else {
      await runtime.database.pool.query("UPDATE public.platform_mail_messages SET status = 'rejected' WHERE reference = $1", [notification.mailReference]);
    }
    behavior.withholdReceipt = false;
    const job = await runtime.database.pool.query<{ id: string }>(
      "SELECT id FROM public.platform_jobs WHERE type = 'platform.notification.deliver' AND payload->>'deliveryId' = $1",
      [notification.deliveryId],
    );
    await runtime.jobs.requeue(runtime.database.db, job.rows[0].id);
    await settle(runtime);

    expect(sink.recipients).toHaveLength(1);
    expect(await notification.evidence()).toMatchObject({ status: 'unknown', attempts: 1 });
    if (mailState === 'missing') expect(await notification.mail()).toBeUndefined();
    else expect(await notification.mail()).toMatchObject({ status: 'rejected', attempts: 1 });
  });

  it('allows one operator decision per reviewed rejection, then allows a new retry after definite failure', async () => {
    const behavior = { rejectAll: true };
    const sink = await smtpSink(behavior);
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test',
      smtp: { host: '127.0.0.1', port: sink.port } }, 1);
    const notification = await emailNotification(runtime, 'security-alert:manual-rejected');
    await settle(runtime);
    expect(await notification.evidence()).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await notification.mail()).toMatchObject({ status: 'rejected', attempts: 1 });

    const decisions = await Promise.allSettled([notification.resend(1), notification.resend(1)]);
    expect(decisions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(decisions.filter(result => result.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'CONFLICT' }) },
    ]);
    await Promise.all([settle(runtime), runtime.notifications.deliver(notification.deliveryId)]);
    expect(sink.recipients).toHaveLength(2);
    expect(await notification.evidence()).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await notification.mail()).toMatchObject({ status: 'rejected', attempts: 2 });
    expect(await notification.audit()).toMatchObject([{
      actorId: resendOperator.id, action: 'notification.email_resent',
      payload: { previousStatus: 'failed', status: 'failed', attempts: 2, acknowledgeDuplicateRisk: false },
    }]);
    await expect(notification.resend(1)).rejects.toMatchObject({ code: 'CONFLICT' });

    behavior.rejectAll = false;
    await notification.resend(2);
    await settle(runtime);
    expect(sink.recipients).toHaveLength(3);
    expect(await notification.evidence()).toMatchObject({ status: 'sent', attempts: 3 });
    expect(await notification.mail()).toMatchObject({ status: 'accepted', attempts: 3 });
  });

  it('enforces Base resend permission in a product command and reconciles a legacy attempt count', async () => {
    const behavior = { withholdReceipt: true };
    const sink = await smtpSink(behavior);
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test',
      smtp: { host: '127.0.0.1', port: sink.port, socketTimeoutMs: 250 } });
    const notification = await emailNotification(runtime, 'security-alert:legacy-unknown');
    await settle(runtime);
    // Before this migration, replays of unknown mail inflated the Notification counter.
    await runtime.database.pool.query('UPDATE public.platform_notification_deliveries SET attempts = 5 WHERE id = $1', [notification.deliveryId]);
    expect(await notification.evidence()).toMatchObject({ status: 'unknown', attempts: 5 });
    expect(await notification.mail()).toMatchObject({ status: 'unknown', attempts: 1 });

    const productCommand = defineCommand({ name: 'test.product.resend', permission: 'mail:send',
      input: resendEmailInput, output: resendEmailOutput });
    const port: NotificationsPort = runtime.notifications;
    runtime.commands.register(productCommand, (input, ctx) => port.requestEmailResend(ctx, input), 'test');
    const input = { deliveryId: notification.deliveryId, expectedAttempts: 5, operationId: randomUUID(), acknowledgeDuplicateRisk: true };
    const mailActor = { ...resendOperator, permissions: ['mail:send'] };
    await expect(runtime.commands.execute(productCommand.name, input, { actor: mailActor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const productActor = { ...resendOperator, permissions: [...resendOperator.permissions, ...mailActor.permissions] };
    await expect(runtime.commands.execute(productCommand.name, input, { actor: productActor }))
      .resolves.toMatchObject({ operationId: input.operationId });
    await expect(runtime.commands.execute(productCommand.name, { ...input, acknowledgeDuplicateRisk: false }, { actor: productActor }))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    behavior.withholdReceipt = false;
    await settle(runtime);
    expect(sink.recipients).toHaveLength(2);
    expect(await notification.evidence()).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await notification.mail()).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(await notification.audit()).toMatchObject([{ actorId: productActor.id, payload: { operationId: input.operationId } }]);
  });

  it('records an accepted operator request as skipped if Mail is erased before its worker claims it', async () => {
    const sink = await smtpSink({ rejectAll: true });
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test',
      smtp: { host: '127.0.0.1', port: sink.port } });
    const notification = await emailNotification(runtime, 'security-alert:manual-erased');
    await settle(runtime);
    await notification.resend(1);
    await runtime.mail.erase(notification.mailReference);
    await settle(runtime);
    expect(sink.recipients).toHaveLength(1);
    expect(await notification.evidence()).toMatchObject({ status: 'skipped', attempts: 1, externalRef: null, lastError: null });
    expect(await notification.mail()).toMatchObject({ status: 'erased', attempts: 1 });
    expect(await notification.audit()).toMatchObject([{
      actorId: resendOperator.id, action: 'notification.email_resend_skipped',
      payload: { previousStatus: 'failed', status: 'skipped', reason: 'mail_changed' },
    }]);
  });

  it('reconciles a committed resend claim without repeating SMTP after an outcome transaction rolls back', async () => {
    const behavior = { rejectAll: true };
    const sink = await smtpSink(behavior);
    const { runtime } = await baseRuntime({ transport: 'smtp', from: 'sender@example.test',
      smtp: { host: '127.0.0.1', port: sink.port } });
    const notification = await emailNotification(runtime, 'security-alert:manual-rollback');
    await settle(runtime);

    // SMTP succeeds, but PostgreSQL rejects the transaction that would write the outcome and audit.
    await runtime.database.pool.query(`CREATE FUNCTION public.reject_resend_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated outcome commit failure'; END; $$;
      CREATE TRIGGER reject_resend_audit BEFORE INSERT ON public.platform_audit_log
      FOR EACH ROW WHEN (NEW.action = 'notification.email_resent') EXECUTE FUNCTION public.reject_resend_audit();`);
    behavior.rejectAll = false;
    const operationId = randomUUID();
    try {
      await notification.resend(1, false, operationId);
      await settle(runtime);
      expect(sink.recipients).toHaveLength(2);
      expect(await notification.evidence()).toMatchObject({ status: 'failed', attempts: 1 });
      expect(await notification.mail()).toMatchObject({ status: 'sending', attempts: 2 });
      expect(await notification.audit()).toEqual([]);
    } finally {
      await runtime.database.pool.query('DROP TRIGGER reject_resend_audit ON public.platform_audit_log');
    }

    await vi.waitFor(async () => {
      await settle(runtime);
      expect(await notification.evidence()).toMatchObject({ status: 'unknown', attempts: 2 });
    }, { timeout: 6000, interval: 100 });
    expect(await notification.mail()).toMatchObject({ status: 'unknown', attempts: 2 });
    await notification.resend(1, false, operationId);
    await runtime.notifications.deliver(notification.deliveryId);
    await settle(runtime);
    expect(sink.recipients).toHaveLength(2);
    expect(await notification.audit()).toMatchObject([{
      actorId: resendOperator.id, action: 'notification.email_resent',
      payload: { operationId, previousStatus: 'failed', status: 'unknown', attempts: 2, attemptedAt: expect.any(String) },
    }]);
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
