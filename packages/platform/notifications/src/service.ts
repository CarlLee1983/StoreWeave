import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PermanentJobError } from '@storeweave/jobs';
import type { AuditWriter } from '@storeweave/audit';
import type { AuthorizationService } from '@storeweave/authorization';
import { PlatformError, type CommandContext, type Logger, type Tx } from '@storeweave/contracts';
import type { Database } from '@storeweave/db';
import { formatMessage } from '@storeweave/i18n';
import type { MailDiagnostic, MailService } from '@storeweave/mail';
import { maskEmailsIn, maskRecipient } from './masking';
import type {
  DeliveryEvidenceDto, InboxItemDto, NotificationChannel, NotificationDeliveryDto, NotificationDeliveryStatus,
  NotificationDto, NotificationTemplate, ResendEmailInput, ResendEmailOutput, SendNotificationInput,
} from './types';

export const NOTIFICATION_DELIVER_JOB = 'platform.notification.deliver';

export const NOTIFICATION_RESEND_JOB = 'platform.notification.resendEmail';
export const NOTIFICATION_RESEND_PERMISSION = 'notifications:resend';

type ResendContext = Pick<CommandContext, 'actor' | 'correlationId' | 'tx' | 'enqueue'>;
type ResendScope = { readonly reference: string };

interface EmailResendRow {
  id: string;
  delivery_id: string;
  actor_id: string;
  correlation_id: string;
  previous_status: 'failed' | 'unknown';
  expected_attempts: number;
  mail_attempts: number;
  acknowledge_duplicate_risk: boolean;
  claimed_at: string | null;
  completed_at: string | null;
  [column: string]: unknown;
}

interface NotificationRow {
  id: string; reference: string; template_id: string; template_version: number; locale: string | null;
  recipient_user_id: string | null; recipient_email: string | null; recipient_name: string | null;
  template: NotificationTemplate; variables: Record<string, unknown>; title: string | null; body: string | null;
  request_hash: string; created_at: Date;
  [column: string]: unknown;
}

interface DeliveryRow {
  id: string; notification_id: string; channel: NotificationChannel; status: NotificationDeliveryStatus;
  attempts: number; external_ref: string | null; last_error: string | null;
  sent_at: Date | null; read_at: Date | null; created_at: Date; updated_at: Date;
  [column: string]: unknown;
}

function toDeliveryDto(row: DeliveryRow): NotificationDeliveryDto {
  return {
    id: row.id, channel: row.channel, status: row.status, attempts: row.attempts,
    externalRef: row.external_ref, lastError: row.last_error,
    sentAt: row.sent_at ? new Date(row.sent_at) : null, readAt: row.read_at ? new Date(row.read_at) : null,
  };
}

function placeholders(template: string): Set<string> {
  return new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]!));
}

/** Fill only the placeholders this string actually uses; one template may address several channels. */
function fill(template: string, variables: Readonly<Record<string, unknown>>): string {
  const params = Object.fromEntries([...placeholders(template)].map(name => {
    if (!Object.hasOwn(variables, name)) throw new Error(`Notification template is missing variable "${name}"`);
    return [name, String(variables[name])];
  }));
  return formatMessage(template, params);
}

/** Exact BCP-47 tag, then its base language, then the template's own strings. */
function localized<T>(content: T & { translations?: Readonly<Record<string, T>> }, locale: string | undefined): T {
  if (!locale || !content.translations) return content;
  return content.translations[locale] ?? content.translations[locale.split('-', 1)[0]!] ?? content;
}

function requestHash(input: SendNotificationInput): string {
  return createHash('sha256').update(JSON.stringify({
    channels: [...input.channels].sort(), recipient: input.recipient, template: input.template,
    variables: input.variables ?? {}, locale: input.locale ?? null,
  })).digest('hex');
}

export interface NotificationJobEnqueue {
  (job: { type: string; payload: unknown; dedupeKey?: string }): Promise<void>;
}

/**
 * What a module is handed when it declares that it notifies people. It is the
 * capability itself, not the manager: a module can create notifications and
 * read back their delivery evidence or request an authorized email resend.
 */
export interface NotificationsPort {
  send(tx: Tx, input: SendNotificationInput, enqueue: NotificationJobEnqueue, now: Date): Promise<NotificationDto>;
  dispatch(input: SendNotificationInput): Promise<NotificationDto>;
  requestEmailResend(ctx: ResendContext, input: ResendEmailInput, scope?: ResendScope): Promise<ResendEmailOutput>;
  evidenceByReference(references: readonly string[]): Promise<Map<string, DeliveryEvidenceDto[]>>;
}

/**
 * Durable, channel-agnostic notifications. The record of who was told what is
 * owned here; which business event produced it is not — mapping stays with the
 * module that owns the event.
 */
export class NotificationService implements NotificationsPort {
  constructor(
    private readonly database: Database,
    private readonly mail: MailService,
    private readonly logger: Logger,
    private readonly enqueueJob: (tx: Tx, job: { type: string; payload: unknown; dedupeKey?: string }) => Promise<unknown>,
    private readonly authorization: Pick<AuthorizationService, 'assert'>,
    private readonly audit: Pick<AuditWriter, 'write'>,
    private readonly resendPermissions: ReadonlyMap<string, string> = new Map(),
  ) {}

  /** For callers outside a command: opens the transaction the durable record needs. */
  async dispatch(input: SendNotificationInput): Promise<NotificationDto> {
    const now = new Date();
    return this.database.transaction(tx => this.send(tx as Tx, input, job => this.enqueueJob(tx as Tx, job).then(() => undefined), now));
  }

  /**
   * Creates the immutable notification and one delivery record per channel in
   * the caller's transaction. The in-app channel is complete once it commits —
   * the inbox row is the delivery. Only the email channel needs a job.
   */
  async send(tx: Tx, input: SendNotificationInput, enqueue: NotificationJobEnqueue, now: Date): Promise<NotificationDto> {
    const variables = input.variables ?? {};
    const inapp = input.template.inapp ? localized(input.template.inapp, input.locale) : undefined;
    const rendered = inapp ? { title: fill(inapp.title, variables), body: fill(inapp.body, variables) } : undefined;
    if (input.template.email) {
      // Fail before the insert rather than at delivery time: a template whose
      // variables do not line up is a programming error, not a transport fault.
      const email = localized(input.template.email, input.locale);
      for (const part of [email.subject, email.text, email.html]) fill(part, variables);
    }
    const hash = requestHash(input);
    const id = randomUUID();
    const inserted = await tx.execute<NotificationRow>(sql`INSERT INTO public.platform_notifications
      (id, reference, template_id, template_version, locale, recipient_user_id, recipient_email, recipient_name, template, variables, title, body, request_hash, created_at)
      VALUES (${id}, ${input.reference}, ${input.template.id}, ${input.template.version}, ${input.locale ?? null},
        ${input.recipient.userId ?? null}, ${input.recipient.email ?? null}, ${input.recipient.name ?? null},
        ${JSON.stringify(input.template)}::jsonb, ${JSON.stringify(variables)}::jsonb,
        ${rendered?.title ?? null}, ${rendered?.body ?? null}, ${hash}, ${now})
      ON CONFLICT (reference) DO NOTHING RETURNING *`);

    // A replayed event, a retried job and a duplicate command all arrive here.
    // The durable fact wins; nothing is delivered a second time.
    if (!inserted.rows[0]) {
      const existing = await tx.execute<NotificationRow>(sql`SELECT * FROM public.platform_notifications WHERE reference = ${input.reference}`);
      const row = existing.rows[0];
      if (!row) throw new Error('Notification reference conflict could not be read');
      if (row.request_hash !== hash) throw new Error('Notification reference already exists with different immutable content');
      const deliveries = await tx.execute<DeliveryRow>(sql`SELECT * FROM public.platform_notification_deliveries WHERE notification_id = ${row.id} ORDER BY channel`);
      return this.toDto(row, deliveries.rows);
    }

    const notification = inserted.rows[0];
    const deliveries: DeliveryRow[] = [];
    for (const channel of [...input.channels].sort()) {
      // Mail that is switched off is a deployment decision, not a delivery
      // failure: record it as skipped instead of retrying a send that cannot work.
      const disabled = channel === 'email' && !this.mail.enabled;
      const status: NotificationDeliveryStatus = channel === 'inapp' ? 'sent' : disabled ? 'skipped' : 'pending';
      const created = await tx.execute<DeliveryRow>(sql`INSERT INTO public.platform_notification_deliveries
        (id, notification_id, channel, status, attempts, last_error, sent_at, created_at, updated_at)
        VALUES (${randomUUID()}, ${notification.id}, ${channel}, ${status}, 0,
          ${disabled ? 'Mail transport is disabled by configuration' : null},
          ${status === 'sent' ? now : null}, ${now}, ${now})
        RETURNING *`);
      const row = created.rows[0]!;
      deliveries.push(row);
      if (status === 'pending') {
        await enqueue({ type: NOTIFICATION_DELIVER_JOB, payload: { deliveryId: row.id }, dedupeKey: `notification:${row.id}` });
      }
    }
    return this.toDto(notification, deliveries);
  }

  /** Reserve an operator decision and its job together, without sending inside the caller's command. */
  async requestEmailResend(ctx: ResendContext, input: ResendEmailInput, scope?: ResendScope): Promise<ResendEmailOutput> {
    const { actor, tx } = ctx;
    const permission = scope ? this.resendPermission(scope.reference) : NOTIFICATION_RESEND_PERMISSION;
    if (!permission || actor.type !== 'user' || !actor.id) {
      throw PlatformError.forbidden('Email resend requires an authorized operator');
    }
    this.authorization.assert({ actor, permission,
      resource: { type: 'notifications', id: input.deliveryId } });

    const delivery = await this.lockDelivery(tx, input.deliveryId);
    if (!delivery || (scope && delivery.notification.reference !== scope.reference)) {
      throw PlatformError.notFound('Notification delivery', input.deliveryId);
    }
    // Product-owned deliveries must go through the product command that resolves
    // the reference. The public Base command accepts an id and has no such scope.
    if (!scope && this.resendPermission(delivery.notification.reference)) {
      throw PlatformError.forbidden('Email resend requires the owning module');
    }
    const existing = await this.resendOperation(tx, input.operationId);
    const receipt = { operationId: input.operationId, deliveryId: input.deliveryId };
    if (existing) {
      if (existing.actor_id !== actor.id || existing.delivery_id !== input.deliveryId ||
          existing.expected_attempts !== input.expectedAttempts ||
          existing.acknowledge_duplicate_risk !== input.acknowledgeDuplicateRisk) {
        throw PlatformError.conflict('This email resend operation has different immutable input');
      }
      return receipt;
    }
    if (delivery.channel !== 'email' || (delivery.status !== 'unknown' && delivery.status !== 'failed') ||
        delivery.attempts !== input.expectedAttempts) {
      throw PlatformError.conflict('Email resend requires current failed or unknown delivery evidence');
    }
    if (delivery.status === 'unknown' && input.acknowledgeDuplicateRisk !== true) {
      throw PlatformError.validation('Resending unknown mail requires acknowledging possible duplicate delivery');
    }
    if (!this.mail.enabled) throw PlatformError.conflict('Email resend requires an enabled mail transport');

    const mail = await this.mail.diagnosticByReference(this.mailReference(delivery), tx);
    if (mail?.status !== (delivery.status === 'failed' ? 'rejected' : 'unknown')) {
      throw PlatformError.conflict('Mail delivery no longer matches the reviewed notification outcome');
    }
    // Keep the caller's observed count for operation identity, and Mail's actual
    // count for the claim. Older Notification rows may have counted job replays.
    const inserted = await tx.execute(sql`INSERT INTO public.platform_notification_email_resends
        (id, delivery_id, actor_id, correlation_id, previous_status, expected_attempts, mail_attempts, acknowledge_duplicate_risk)
      VALUES (${input.operationId}, ${delivery.id}, ${actor.id}, ${ctx.correlationId}, ${delivery.status},
        ${input.expectedAttempts}, ${mail.attempts}, ${input.acknowledgeDuplicateRisk})
      ON CONFLICT DO NOTHING RETURNING id`);
    if (!inserted.rows[0]) throw PlatformError.conflict('An email resend is already queued or this operation ID is in use');
    await ctx.enqueue({ type: NOTIFICATION_RESEND_JOB, payload: receipt, dedupeKey: `notification-resend:${input.operationId}` });
    return receipt;
  }

  private resendPermission(reference: string): string | undefined {
    const separator = reference.indexOf(':');
    return separator === -1 ? undefined : this.resendPermissions.get(reference.slice(0, separator));
  }

  async processEmailResend({ deliveryId, operationId }: ResendEmailOutput): Promise<void> {
    // Commit the operation's claim together with Mail's SMTP attempt marker.
    // A replay of this job can recover the outcome without claiming again.
    const claim = await this.database.transaction(async tx => {
      const delivery = await this.lockDelivery(tx, deliveryId);
      const operation = await this.resendOperation(tx, operationId);
      if (!delivery || !operation || operation.delivery_id !== deliveryId || operation.completed_at) return;
      const reference = this.mailReference(delivery);
      if (operation.claimed_at) {
        const prior = await this.mail.diagnosticByReference(reference, tx);
        if (prior) return { mail: prior, recover: true };
        await this.skipResend(tx, delivery, operation, undefined, 'mail_unavailable');
        return;
      }
      const mail = this.mail.enabled
        ? await this.mail.claimResend(tx, reference, operation.previous_status === 'failed' ? 'rejected' : 'unknown', operation.mail_attempts)
        : undefined;
      if (!mail) {
        const prior = await this.mail.diagnosticByReference(reference, tx);
        await this.skipResend(tx, delivery, operation, prior, !this.mail.enabled ? 'mail_disabled' : 'mail_changed');
        return;
      }
      await tx.execute(sql`UPDATE public.platform_notification_email_resends
        SET claimed_at = pg_catalog.clock_timestamp() WHERE id = ${operationId}`);
      return { mail, recover: false };
    });
    if (!claim) return;

    await this.database.transaction(async tx => {
      const delivery = await this.lockDelivery(tx, deliveryId);
      const operation = await this.resendOperation(tx, operationId);
      if (!delivery || !operation?.claimed_at || operation.completed_at) return;
      const attempted = claim.recover
        ? await this.mail.recoverClaimedDelivery(tx, claim.mail.id, operation.mail_attempts + 1)
        : (await this.mail.deliverClaimed(tx, claim.mail)).result;
      if (attempted.attempts !== operation.mail_attempts + 1 || attempted.status === 'erased') {
        await this.skipResend(tx, delivery, operation, attempted, 'mail_changed');
        return;
      }
      const saved = await this.record(tx, delivery, attempted);
      await this.audit.write(tx, {
        action: 'notification.email_resent', resourceType: 'notification_delivery', resourceId: deliveryId,
        actor: { id: operation.actor_id, type: 'user', permissions: [] }, correlationId: operation.correlation_id,
        payload: { operationId, previousStatus: operation.previous_status, status: saved.status, attempts: saved.attempts,
          acknowledgeDuplicateRisk: operation.acknowledge_duplicate_risk, attemptedAt: new Date(operation.claimed_at).toISOString() },
      });
      await this.completeResend(tx, operation.id);
    });
  }

  /** Mail owns the SMTP outcome. Automatic delivery stops once an operator has taken over. */
  async deliver(deliveryId: string): Promise<NotificationDeliveryDto> {
    const preparation = await this.database.transaction(async tx => {
      const delivery = await this.lockDelivery(tx, deliveryId);
      if (!delivery) throw new PermanentJobError('Notification delivery no longer exists');
      if (delivery.channel !== 'email') throw new PermanentJobError(`Channel "${delivery.channel}" is delivered without a job`);
      if (!await this.canDeliverAutomatically(tx, delivery)) return { delivery };
      const notification = delivery.notification;
      const template = notification.template.email;
      if (!template || !notification.recipient_email) throw new PermanentJobError('Notification has no email content or recipient');
      const mail = await this.mail.prepareImmediateDelivery(tx, {
        reference: this.mailReference(delivery),
        to: [notification.recipient_name
          ? { email: notification.recipient_email, name: notification.recipient_name }
          : { email: notification.recipient_email }],
        template: { id: notification.template_id, version: notification.template_version, ...template },
        variables: notification.variables,
        ...(notification.locale ? { locale: notification.locale } : {}),
      });
      return { delivery, mail };
    });
    if (!preparation.mail) return toDeliveryDto(preparation.delivery);
    const { claimed, diagnostic } = preparation.mail;
    const outcome = await this.database.transaction(async tx => {
      const delivery = await this.lockDelivery(tx, deliveryId);
      if (!delivery) throw new PermanentJobError('Notification delivery no longer exists');
      if (!await this.canDeliverAutomatically(tx, delivery)) return { saved: toDeliveryDto(delivery) };
      const mail = claimed
        ? await this.mail.deliverClaimed(tx, diagnostic)
        : diagnostic.status === 'sending'
          ? { result: await this.mail.recoverClaimedDelivery(tx, diagnostic.id, diagnostic.attempts) }
          : { result: await this.mail.diagnosticByReference(diagnostic.reference, tx) ?? diagnostic };
      // A replay of a completed or uncertain Mail outcome does not count as a delivery attempt.
      const saved = await this.record(tx, delivery, mail.result);
      return { saved, permanentError: 'permanentError' in mail ? mail.permanentError : undefined };
    });
    if (outcome.permanentError) throw new PermanentJobError(outcome.permanentError);
    if (outcome.saved.status === 'failed') throw new Error(outcome.saved.lastError ?? 'Mail rejected the notification recipient');
    return outcome.saved;
  }

  async inbox(userId: string, filter: { unreadOnly: boolean; limit: number; offset: number }): Promise<{ items: InboxItemDto[]; total: number; unread: number }> {
    const rows = await this.database.pool.query<{
      id: string; notification_id: string; reference: string; template_id: string; title: string; body: string; created_at: Date; read_at: Date | null;
    }>(
      `SELECT d.id, d.notification_id, n.reference, n.template_id, coalesce(n.title, '') AS title, coalesce(n.body, '') AS body,
              n.created_at, d.read_at
       FROM public.platform_notification_deliveries d
       JOIN public.platform_notifications n ON n.id = d.notification_id
       WHERE d.channel = 'inapp' AND n.recipient_user_id = $1 AND (NOT $2::boolean OR d.read_at IS NULL)
       ORDER BY n.created_at DESC, d.id LIMIT $3 OFFSET $4`,
      [userId, filter.unreadOnly, filter.limit, filter.offset]);
    const counts = await this.database.pool.query<{ total: string; unread: string }>(
      `SELECT count(*) FILTER (WHERE NOT $2::boolean OR d.read_at IS NULL)::text AS total,
              count(*) FILTER (WHERE d.read_at IS NULL)::text AS unread
       FROM public.platform_notification_deliveries d
       JOIN public.platform_notifications n ON n.id = d.notification_id
       WHERE d.channel = 'inapp' AND n.recipient_user_id = $1`, [userId, filter.unreadOnly]);
    return {
      items: rows.rows.map(row => ({
        id: row.id, notificationId: row.notification_id, reference: row.reference, templateId: row.template_id,
        title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at,
      })),
      total: Number(counts.rows[0]?.total ?? 0),
      unread: Number(counts.rows[0]?.unread ?? 0),
    };
  }

  /** Scoped to the caller's own inbox in SQL; an id from someone else's inbox simply matches nothing. */
  async markRead(tx: Tx, userId: string, ids: readonly string[], now: Date): Promise<number> {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE public.platform_notification_deliveries d
      SET read_at = ${now}, updated_at = ${now}
      FROM public.platform_notifications n
      WHERE n.id = d.notification_id AND d.channel = 'inapp' AND d.read_at IS NULL
        AND n.recipient_user_id = ${userId} AND d.id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
      RETURNING d.id`);
    return updated.rows.length;
  }

  async evidence(filter: { channel?: NotificationChannel; status?: NotificationDeliveryStatus; reference?: string; references?: readonly string[]; limit: number; offset: number }): Promise<{ items: DeliveryEvidenceDto[]; total: number }> {
    const where = `WHERE ($1::text IS NULL OR d.channel = $1) AND ($2::text IS NULL OR d.status = $2) AND ($3::text IS NULL OR n.reference = $3)
       AND ($4::text[] IS NULL OR n.reference = ANY($4::text[]))`;
    const parameters = [filter.channel ?? null, filter.status ?? null, filter.reference ?? null, filter.references ? [...filter.references] : null];
    const rows = await this.database.pool.query<DeliveryRow & { reference: string; template_id: string; template_version: number; recipient_email: string | null; recipient_user_id: string | null }>(
      `SELECT d.*, n.reference, n.template_id, n.template_version, n.recipient_email, n.recipient_user_id
       FROM public.platform_notification_deliveries d
       JOIN public.platform_notifications n ON n.id = d.notification_id
       ${where} ORDER BY d.created_at DESC, d.id LIMIT $5 OFFSET $6`, [...parameters, filter.limit, filter.offset]);
    const total = await this.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.platform_notification_deliveries d
       JOIN public.platform_notifications n ON n.id = d.notification_id ${where}`, parameters);
    return {
      items: rows.rows.map(row => ({
        id: row.id, notificationId: row.notification_id, reference: row.reference,
        templateId: row.template_id, templateVersion: row.template_version,
        channel: row.channel, status: row.status, attempts: row.attempts,
        recipientMasked: row.recipient_email ? maskRecipient(row.recipient_email) : `user:${row.recipient_user_id ?? 'unknown'}`,
        externalRef: row.external_ref, lastError: maskEmailsIn(row.last_error),
        sentAt: row.sent_at, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  /**
   * Delivery evidence for notifications another module created. It is how a
   * business module answers "did that go out" without reading these tables.
   */
  async evidenceByReference(references: readonly string[]): Promise<Map<string, DeliveryEvidenceDto[]>> {
    const result = new Map<string, DeliveryEvidenceDto[]>();
    if (references.length === 0) return result;
    const rows = await this.evidence({ references: [...references], limit: references.length * 2, offset: 0 });
    for (const item of rows.items) {
      const existing = result.get(item.reference);
      if (existing) existing.push(item); else result.set(item.reference, [item]);
    }
    return result;
  }

  private async lockDelivery(tx: Tx, id: string): Promise<(DeliveryRow & { notification: NotificationRow }) | undefined> {
    const loaded = await tx.execute<DeliveryRow & { notification: NotificationRow }>(sql`
      SELECT d.*, to_jsonb(n.*) AS notification
      FROM public.platform_notification_deliveries d
      JOIN public.platform_notifications n ON n.id = d.notification_id
      WHERE d.id = ${id} FOR UPDATE OF d`);
    return loaded.rows[0];
  }

  private mailReference(delivery: { notification: NotificationRow }): string {
    return `notification:${delivery.notification.reference}:email`;
  }

  private async resendOperation(tx: Tx, id: string): Promise<EmailResendRow | undefined> {
    const operations = await tx.execute<EmailResendRow>(sql`
      SELECT * FROM public.platform_notification_email_resends WHERE id = ${id}`);
    return operations.rows[0];
  }

  private async canDeliverAutomatically(tx: Tx, delivery: DeliveryRow): Promise<boolean> {
    // An unknown Notification remains fenced even if the Mail record is missing or changed.
    if (delivery.status !== 'pending' && delivery.status !== 'failed') return false;
    const operations = await tx.execute(sql`
      SELECT 1 FROM public.platform_notification_email_resends WHERE delivery_id = ${delivery.id} LIMIT 1`);
    return operations.rows.length === 0;
  }

  private async skipResend(tx: Tx, delivery: DeliveryRow, operation: EmailResendRow, mail: MailDiagnostic | undefined,
    reason: 'mail_unavailable' | 'mail_disabled' | 'mail_changed'): Promise<void> {
    const current = mail && mail.status !== 'sending' && mail.status !== 'pending'
      ? await this.record(tx, delivery, mail)
      : toDeliveryDto(delivery);
    await this.audit.write(tx, {
      action: 'notification.email_resend_skipped', resourceType: 'notification_delivery', resourceId: delivery.id,
      actor: { id: operation.actor_id, type: 'user', permissions: [] }, correlationId: operation.correlation_id,
      payload: { operationId: operation.id, previousStatus: operation.previous_status, status: current.status,
        acknowledgeDuplicateRisk: operation.acknowledge_duplicate_risk, reason },
    });
    await this.completeResend(tx, operation.id);
  }

  private async completeResend(tx: Tx, id: string): Promise<void> {
    await tx.execute(sql`UPDATE public.platform_notification_email_resends
      SET completed_at = pg_catalog.clock_timestamp() WHERE id = ${id}`);
  }

  private async record(tx: Tx, delivery: DeliveryRow, mail: MailDiagnostic): Promise<NotificationDeliveryDto> {
    const status: NotificationDeliveryStatus = mail.status === 'accepted' || mail.status === 'partial' ? 'sent'
      : mail.status === 'rejected' ? 'failed'
        : mail.status === 'unknown' ? 'unknown'
          : mail.status === 'erased' ? 'skipped' : 'pending';
    const error = status === 'failed' && mail.diagnosticKind ? 'Mail transport rejected delivery'
      : status === 'failed' || status === 'unknown'
        ? maskEmailsIn(mail.diagnosticMessage ?? `Mail reported ${mail.status} for ${mail.rejected.length} recipient(s)`)
        : null;
    const externalRef = mail.status === 'erased' ? null : mail.messageId;
    if (delivery.status === status && delivery.attempts === mail.attempts && delivery.last_error === error &&
        delivery.external_ref === externalRef) return toDeliveryDto(delivery);
    const saved = await tx.execute<DeliveryRow>(sql`
      UPDATE public.platform_notification_deliveries
      SET status = ${status}, attempts = ${mail.attempts}, external_ref = ${externalRef}, last_error = ${error},
          sent_at = CASE WHEN ${status} = 'sent' THEN coalesce(sent_at, pg_catalog.clock_timestamp()) ELSE sent_at END,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = ${delivery.id} RETURNING *`);
    if (!saved.rows[0]) throw new PermanentJobError('Notification delivery disappeared while recording its outcome');
    if (status !== 'sent') this.logger.warn({ deliveryId: delivery.id, status }, 'notification channel did not confirm delivery');
    return toDeliveryDto(saved.rows[0]);
  }

  private toDto(notification: NotificationRow, deliveries: readonly DeliveryRow[]): NotificationDto {
    return {
      id: notification.id, reference: notification.reference,
      templateId: notification.template_id, templateVersion: notification.template_version,
      createdAt: notification.created_at, deliveries: deliveries.map(toDeliveryDto),
    };
  }
}
