import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PermanentJobError } from '@storeweave/jobs';
import type { Logger, Tx } from '@storeweave/contracts';
import type { Database } from '@storeweave/db';
import { formatMessage } from '@storeweave/i18n';
import type { MailService } from '@storeweave/mail';
import { maskEmailsIn, maskRecipient } from './masking';
import type {
  DeliveryEvidenceDto, InboxItemDto, NotificationChannel, NotificationDeliveryDto, NotificationDeliveryStatus,
  NotificationDto, NotificationTemplate, SendNotificationInput,
} from './types';

export const NOTIFICATION_DELIVER_JOB = 'platform.notification.deliver';

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
    externalRef: row.external_ref, lastError: row.last_error, sentAt: row.sent_at, readAt: row.read_at,
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
 * read back their delivery evidence, and can do nothing else here.
 */
export interface NotificationsPort {
  send(tx: Tx, input: SendNotificationInput, enqueue: NotificationJobEnqueue, now: Date): Promise<NotificationDto>;
  dispatch(input: SendNotificationInput): Promise<NotificationDto>;
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

  /**
   * The email channel's job body. Mail owns the SMTP outcome; this records what
   * that outcome means for the notification and decides whether to retry.
   */
  async deliver(deliveryId: string): Promise<NotificationDeliveryDto> {
    const loaded = await this.database.pool.query<DeliveryRow & { notification: NotificationRow }>(
      `SELECT d.*, to_jsonb(n.*) AS notification
       FROM public.platform_notification_deliveries d
       JOIN public.platform_notifications n ON n.id = d.notification_id
       WHERE d.id = $1`, [deliveryId]);
    const row = loaded.rows[0];
    if (!row) throw new PermanentJobError('Notification delivery no longer exists');
    if (row.channel !== 'email') throw new PermanentJobError(`Channel "${row.channel}" is delivered without a job`);
    if (row.status === 'sent' || row.status === 'skipped') return toDeliveryDto(row);
    const notification = row.notification;
    const reference = `notification:${notification.reference}:email`;
    const template = notification.template.email;
    if (!template || !notification.recipient_email) throw new PermanentJobError('Notification has no email content or recipient');

    const claimed = await this.database.pool.query<DeliveryRow>(
      `UPDATE public.platform_notification_deliveries SET attempts = attempts + 1, updated_at = pg_catalog.clock_timestamp()
       WHERE id = $1 RETURNING *`, [deliveryId]);
    try {
      const prior = await this.mail.diagnosticByReference(reference);
      // A rejected mail message keeps its durable render; re-delivering it is
      // the documented retry, and re-queueing would only duplicate the record.
      const diagnostic = !prior
        ? await this.mail.sendNow({
          reference,
          to: [notification.recipient_name
            ? { email: notification.recipient_email, name: notification.recipient_name }
            : { email: notification.recipient_email }],
          template: { id: notification.template_id, version: notification.template_version, ...template },
          variables: notification.variables,
          ...(notification.locale ? { locale: notification.locale } : {}),
        })
        : prior.status === 'rejected' || prior.status === 'pending'
          ? await this.mail.deliver(prior.id)
          : prior;

      const status: NotificationDeliveryStatus = diagnostic.status === 'accepted' || diagnostic.status === 'partial'
        ? 'sent' : diagnostic.status === 'rejected' ? 'failed' : 'unknown';
      const error = status === 'sent' ? null
        : diagnostic.diagnosticMessage ?? `Mail reported ${diagnostic.status} for ${diagnostic.rejected.length} recipient(s)`;
      const saved = await this.record(deliveryId, status, diagnostic.messageId, error);
      // The failure fact commits before the throw hands the job back to the
      // queue, so a retry is observable. An `unknown` outcome deliberately
      // returns instead: the message may already be in the recipient's mailbox.
      if (status === 'failed') throw new Error(error ?? 'Mail rejected the notification recipient');
      return saved;
    } catch (failure) {
      // Mail dead-letters an auth, configuration or envelope failure. Record
      // why before it stops being retried, then let it dead-letter here too.
      if (failure instanceof PermanentJobError) {
        await this.record(deliveryId, 'failed', claimed.rows[0]?.external_ref ?? null, failure.message);
      }
      throw failure;
    }
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

  private async record(id: string, status: NotificationDeliveryStatus, externalRef: string | null, error: string | null): Promise<NotificationDeliveryDto> {
    const saved = await this.database.pool.query<DeliveryRow>(
      `UPDATE public.platform_notification_deliveries
       SET status = $2, external_ref = $3, last_error = $4, sent_at = CASE WHEN $2 = 'sent' THEN pg_catalog.clock_timestamp() ELSE sent_at END,
           updated_at = pg_catalog.clock_timestamp()
       WHERE id = $1 RETURNING *`, [id, status, externalRef, error === null ? null : maskEmailsIn(error)]);
    const row = saved.rows[0];
    if (!row) throw new PermanentJobError('Notification delivery disappeared while recording its outcome');
    if (status !== 'sent') this.logger.warn({ deliveryId: id, status }, 'notification channel did not confirm delivery');
    return toDeliveryDto(row);
  }

  private toDto(notification: NotificationRow, deliveries: readonly DeliveryRow[]): NotificationDto {
    return {
      id: notification.id, reference: notification.reference,
      templateId: notification.template_id, templateVersion: notification.template_version,
      createdAt: notification.created_at, deliveries: deliveries.map(toDeliveryDto),
    };
  }
}
