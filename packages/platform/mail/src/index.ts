import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import nodemailer from 'nodemailer';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PermanentJobError, type JobHandler, type JobQueue } from '@storeweave/jobs';
import type { Logger, Tx } from '@storeweave/contracts';
import type { BaseConfig, SecretProvider } from '@storeweave/config';
import { escapeHtml, formatMessage } from '@storeweave/i18n';
import type { StorageManager } from '@storeweave/storage';
import { sqlMigration, type MigrationSet } from '@storeweave/db';
import type { Database } from '@storeweave/db';

export const MAIL_SEND_JOB = 'platform.mail.send';

export const mailMigrations: MigrationSet = {
  module: 'platform-mail',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_mail_messages (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  template_id text NOT NULL,
  template_version integer NOT NULL,
  locale text,
  sender text NOT NULL,
  recipients jsonb NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  text_body text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_hash char(64) NOT NULL,
  message_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'accepted', 'partial', 'rejected', 'unknown')),
  attempts integer NOT NULL DEFAULT 0,
  accepted jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejected jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknown jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostic_kind text,
  diagnostic_message text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX IF NOT EXISTS platform_mail_messages_status_idx
  ON public.platform_mail_messages (status, updated_at DESC);
`), sqlMigration('0002_reference_erasure', 'expand', `
ALTER TABLE public.platform_mail_messages DROP CONSTRAINT platform_mail_messages_status_check;
ALTER TABLE public.platform_mail_messages ADD CONSTRAINT platform_mail_messages_status_check
  CHECK (status IN ('pending', 'sending', 'accepted', 'partial', 'rejected', 'unknown', 'erased'));
`)],
};

export interface MailTemplate {
  /** Stable, caller-owned template identity, for example `identity.password-reset`. */
  readonly id: string;
  /** Bump whenever the rendered contract changes. Pending jobs retain a render snapshot. */
  readonly version: number;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Locale-specific source with exact-tag then base-language fallback. */
  readonly translations?: Readonly<Record<string, { readonly subject: string; readonly html: string; readonly text: string }>>;
}

export interface MailRecipient { readonly email: string; readonly name?: string; }
export interface MailAttachment { readonly namespace: string; readonly id: string; readonly filename?: string; }
export interface MailSendRequest {
  readonly reference: string;
  readonly to: readonly MailRecipient[];
  readonly template: MailTemplate;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly locale?: string;
  readonly attachments?: readonly MailAttachment[];
}

export interface MailDiagnostic {
  readonly id: string;
  readonly reference: string;
  readonly messageId: string;
  readonly status: 'pending' | 'sending' | 'accepted' | 'partial' | 'rejected' | 'unknown' | 'erased';
  readonly attempts: number;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly unknown: readonly string[];
  readonly diagnosticKind: string | null;
  readonly diagnosticMessage: string | null;
  readonly template: { readonly id: string; readonly version: number; };
}

type StoredMessage = MailDiagnostic & {
  sender: string; recipients: MailRecipient[]; subject: string; html: string; textBody: string; attachments: MailAttachment[];
};

export interface MailTransportInput {
  readonly from: string; readonly to: readonly MailRecipient[]; readonly subject: string; readonly html: string; readonly text: string;
  readonly messageId: string; readonly attachments: readonly { filename: string; contentType: string; content: Readable }[];
}
export interface MailTransportResult { readonly accepted: readonly string[]; readonly rejected: readonly string[]; readonly pending?: readonly string[]; readonly response?: string; }
export interface MailTransport { send(input: MailTransportInput): Promise<MailTransportResult>; verify?(): Promise<void>; close?(): void | Promise<void>; }

class DisabledTransport implements MailTransport {
  async send(): Promise<MailTransportResult> { throw new MailTransportFailure('disabled', 'Mail transport is disabled'); }
}

export class MailTransportFailure extends Error {
  constructor(readonly kind: 'auth' | 'timeout' | 'disabled' | 'permanent' | 'unknown', message: string) { super(message); }
}

export function createSmtpMailTransport(config: BaseConfig['mail'], secrets: SecretProvider): MailTransport {
  if (config.transport === 'disabled') return new DisabledTransport();
  const smtp = config.smtp!;
  const username = smtp.usernameRef ? secrets.get(smtp.usernameRef) : undefined;
  const password = smtp.passwordRef ? secrets.get(smtp.passwordRef) : undefined;
  if ((smtp.usernameRef && !username) || (smtp.passwordRef && !password)) throw new Error('SMTP credentials are not available from the configured secret provider');
  const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
    ...(username ? { auth: { user: username, pass: password! } } : {}),
    connectionTimeout: smtp.connectionTimeoutMs, socketTimeout: smtp.socketTimeoutMs,
  });
  return {
    async send(input) {
      try {
        const recipients = input.to.map(recipient => recipient.name === undefined ? recipient.email : { address: recipient.email, name: recipient.name });
        const info = await transport.sendMail({ from: input.from, to: recipients, subject: input.subject, html: input.html, text: input.text,
          messageId: input.messageId, attachments: input.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        });
        return { accepted: info.accepted.map(String), rejected: info.rejected.map(String), pending: info.pending?.map(String), response: info.response };
      } catch (error) {
        const candidate = error as NodeJS.ErrnoException & { code?: string; responseCode?: number };
        const kind = candidate.code === 'EAUTH' || candidate.responseCode === 535 ? 'auth'
          : candidate.code === 'ETIMEDOUT' || candidate.code === 'ESOCKETTIMEDOUT' ? 'timeout'
            : candidate.code === 'EENVELOPE' ? 'permanent' : 'unknown';
        throw new MailTransportFailure(kind, candidate.message);
      }
    },
    async verify() { await transport.verify(); },
    close: () => transport.close(),
  };
}

function assertRequest(request: MailSendRequest): void {
  if (!request.reference || request.reference.length > 240) throw new Error('Mail reference is required and must be at most 240 characters');
  if (request.to.length === 0) throw new Error('Mail requires at least one recipient');
  if (!request.template.id || !Number.isSafeInteger(request.template.version) || request.template.version < 1) throw new Error('Mail template needs a stable id and positive integer version');
  for (const recipient of request.to) if (!z.string().email().safeParse(recipient.email).success || /[\r\n]/.test(recipient.name ?? '')) throw new Error('Mail recipient is invalid');
  if (/[\r\n]/.test(request.template.subject)) throw new Error('Mail subject template must not contain a line break');
}
function render(request: MailSendRequest): { subject: string; html: string; text: string } {
  const translation = selectTranslation(request.template, request.locale);
  const source = translation ?? request.template;
  const strings = Object.fromEntries(Object.entries(request.variables ?? {}).map(([key, value]) => [key, String(value)]));
  const names = (template: string) => new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]));
  const all = new Set([...names(source.subject), ...names(source.text), ...names(source.html)]);
  for (const key of Object.keys(strings)) if (!all.has(key)) throw new Error(`Mail template does not use variable "${key}"`);
  for (const key of all) if (!Object.hasOwn(strings, key)) throw new Error(`Mail template is missing variable "${key}"`);
  const component = (template: string, escape = false) => {
    const parameters = Object.fromEntries([...names(template)].map(key => [key, escape ? escapeHtml(strings[key] ?? '') : strings[key] ?? '']));
    return formatMessage(template, parameters);
  };
  const subject = component(source.subject);
  if (/[\r\n]/.test(subject)) throw new Error('Rendered mail subject must not contain a line break');
  return { subject, text: component(source.text), html: component(source.html, true) };
}
function selectTranslation(template: MailTemplate, locale: string | undefined) {
  if (!locale || !template.translations) return undefined;
  return template.translations[locale] ?? template.translations[locale.split('-', 1)[0]];
}
function messageId(storeId: string, reference: string): string {
  return `<${createHash('sha256').update(`${storeId}\u0000${reference}`).digest('hex')}@storeweave.mail>`;
}
function requestHash(sender: string, request: MailSendRequest, body: { subject: string; html: string; text: string }): string {
  return createHash('sha256').update(JSON.stringify({ sender, to: request.to, locale: request.locale ?? null,
    template: { id: request.template.id, version: request.template.version }, body, attachments: request.attachments ?? [] })).digest('hex');
}
function values(row: any): StoredMessage {
  return { id: row.id, reference: row.reference, messageId: row.message_id, status: row.status, attempts: row.attempts,
    accepted: row.accepted ?? [], rejected: row.rejected ?? [], unknown: row.unknown ?? [], diagnosticKind: row.diagnostic_kind ?? null, diagnosticMessage: row.diagnostic_message ?? null,
    template: { id: row.template_id, version: row.template_version }, sender: row.sender, recipients: row.recipients, subject: row.subject, html: row.html, textBody: row.text_body, attachments: row.attachments ?? [],
  };
}
function diagnostic(message: StoredMessage): MailDiagnostic { const { sender: _sender, recipients: _recipients, subject: _subject, html: _html, textBody: _text, attachments: _attachments, ...result } = message; return result; }

export const mailSendJobPayload = z.object({ messageId: z.string().uuid(), templateId: z.string().min(1), templateVersion: z.number().int().positive() }).strict();

/** Durable base-mail capability. Queued sends snapshot rendered content before enqueueing, so template edits never corrupt pending work. */
export class MailService {
  private readonly transport: MailTransport;
  constructor(private readonly database: Database, private readonly jobs: JobQueue,
    private readonly storage: StorageManager, config: BaseConfig, secrets: SecretProvider, private readonly logger: Logger, transport?: MailTransport) {
    this.transport = transport ?? createSmtpMailTransport(config.mail, secrets);
    this.sender = config.mail.from ?? 'disabled@invalid';
    this.storeId = config.store.id;
  }
  private readonly sender: string;
  private readonly storeId: string;

  async queue(tx: Tx, request: MailSendRequest): Promise<MailDiagnostic> {
    const message = await this.create(tx, request);
    if (message.status === 'accepted' || message.status === 'partial' || message.status === 'erased') return diagnostic(message);
    await this.jobs.enqueue(tx, { type: MAIL_SEND_JOB, payload: { messageId: message.id, templateId: message.template.id, templateVersion: message.template.version }, dedupeKey: `mail:${message.reference}` });
    return diagnostic(message);
  }
  async enqueue(request: MailSendRequest): Promise<MailDiagnostic> {
    return this.inTransaction(tx => this.queue(tx as Tx, request));
  }
  async sendNow(request: MailSendRequest): Promise<MailDiagnostic> {
    const prior = await this.diagnosticByReference(request.reference);
    if (prior) {
      if (prior.status === 'sending') return (await this.markSendingUnknown(prior.id))
        ?? (await this.diagnosticByReference(request.reference)) ?? prior;
      return prior;
    }
    const created = await this.inTransaction(tx => this.create(tx as Tx, request));
    if (created.status === 'accepted' || created.status === 'partial' || created.status === 'erased') return diagnostic(created);
    return this.deliver(created.id, created.template);
  }
  async diagnosticByReference(reference: string): Promise<MailDiagnostic | undefined> {
    const result = await this.database.pool.query('SELECT * FROM public.platform_mail_messages WHERE reference = $1', [reference]);
    return result.rows[0] ? diagnostic(values(result.rows[0])) : undefined;
  }
  /** The reference tombstone also fences a send that has not created its row yet. */
  async erase(reference: string): Promise<MailDiagnostic> {
    if (!reference || reference.length > 240) throw new Error('Mail reference is required and must be at most 240 characters');
    return this.database.transaction(async tx => {
      const erased = await tx.execute<any>(sql`INSERT INTO public.platform_mail_messages
        (id, reference, template_id, template_version, locale, sender, recipients, subject, html, text_body,
         attachments, request_hash, message_id, status)
        VALUES (${randomUUID()}, ${reference}, '', 1, NULL, '', '[]'::jsonb, '', '', '',
          '[]'::jsonb, ${'0'.repeat(64)}, ${messageId(this.storeId, reference)}, 'erased')
        ON CONFLICT (reference) DO UPDATE SET
          template_id = '', template_version = 1, locale = NULL, sender = '', recipients = '[]'::jsonb,
          subject = '', html = '', text_body = '', attachments = '[]'::jsonb,
          request_hash = ${'0'.repeat(64)}, status = 'erased',
          accepted = '[]'::jsonb, rejected = '[]'::jsonb, unknown = '[]'::jsonb,
          diagnostic_kind = NULL, diagnostic_message = NULL, updated_at = pg_catalog.clock_timestamp()
        RETURNING *`);
      const message = values(erased.rows[0]);
      // A mail job contains only a message UUID and template trace. Its error text
      // can contain SMTP diagnostics, so clear that evidence in the same commit.
      await tx.execute(sql`UPDATE public.platform_jobs SET last_error = NULL
        WHERE type = ${MAIL_SEND_JOB} AND payload->>'messageId' = ${message.id}`);
      await tx.execute(sql`UPDATE public.platform_job_quarantine SET reason = '', payload = '{}'::jsonb
        WHERE type = ${MAIL_SEND_JOB} AND payload->>'messageId' = ${message.id}`);
      return diagnostic(message);
    });
  }
  /** Explicit operator action after reconciling an uncertain SMTP result. */
  async resendUnknown(reference: string): Promise<MailDiagnostic> {
    const reset = await this.database.pool.query(`UPDATE public.platform_mail_messages
      SET status = 'pending', diagnostic_kind = NULL, diagnostic_message = NULL, updated_at = pg_catalog.clock_timestamp()
      WHERE reference = $1 AND status = 'unknown' RETURNING *`, [reference]);
    if (!reset.rows[0]) throw new Error('Only an unknown mail outcome can be explicitly resent');
    const message = values(reset.rows[0]);
    return this.deliver(message.id, message.template);
  }
  async deliver(id: string, expected?: { id: string; version: number }): Promise<MailDiagnostic> {
    const claimed = await this.database.pool.query(`UPDATE public.platform_mail_messages SET status = 'sending', attempts = attempts + 1, updated_at = pg_catalog.clock_timestamp()
      WHERE id = $1 AND status IN ('pending', 'rejected') RETURNING *`, [id]);
    if (!claimed.rows[0]) {
      const previous = await this.database.pool.query('SELECT * FROM public.platform_mail_messages WHERE id = $1', [id]);
      if (!previous.rows[0]) throw new PermanentJobError('Mail message no longer exists');
      return diagnostic(values(previous.rows[0]));
    }
    // The committed sending claim survives a crash. The second transaction is
    // the SMTP fence: erasure waits on this row until the transport settles.
    const outcome = await this.database.transaction(async tx => {
      const locked = await tx.execute<any>(sql`SELECT * FROM public.platform_mail_messages WHERE id = ${id} FOR UPDATE`);
      if (!locked.rows[0]) throw new PermanentJobError('Mail message no longer exists');
      const message = values(locked.rows[0]);
      if (message.status !== 'sending') return { result: diagnostic(message), permanentError: undefined as string | undefined };
      if (expected && (message.template.id !== expected.id || message.template.version !== expected.version)) {
        throw new PermanentJobError('Mail job template trace does not match its durable message snapshot');
      }
      const streams: Readable[] = [];
      try {
        const attachments = await Promise.all(message.attachments.map(async attachment => {
          try {
            const opened = await this.storage.open(attachment.namespace, attachment.id);
            streams.push(opened.content.stream);
            return { filename: attachment.filename ?? opened.object.originalName, contentType: opened.object.contentType, content: opened.content.stream };
          } catch {
            throw new MailTransportFailure('permanent', 'Mail attachment is unavailable');
          }
        }));
        const result = await this.transport.send({ from: message.sender, to: message.recipients, subject: message.subject, html: message.html, text: message.textBody,
          messageId: message.messageId, attachments });
        const accepted = [...result.accepted]; const rejected = [...result.rejected]; const unknown = [...result.pending ?? []];
        const status = accepted.length > 0 ? rejected.length > 0 || unknown.length > 0 ? 'partial' : 'accepted'
          : rejected.length > 0 ? 'rejected' : 'unknown';
        const saved = await tx.execute<any>(sql`UPDATE public.platform_mail_messages SET status = ${status}, accepted = ${JSON.stringify(accepted)}::jsonb,
          rejected = ${JSON.stringify(rejected)}::jsonb, unknown = ${JSON.stringify(unknown)}::jsonb,
          diagnostic_kind = NULL, diagnostic_message = ${result.response ?? null}, updated_at = pg_catalog.clock_timestamp()
          WHERE id = ${message.id} RETURNING *`);
        return { result: diagnostic(values(saved.rows[0])), permanentError: undefined as string | undefined };
      } catch (error) {
        for (const stream of streams) stream.destroy();
        const failure = error instanceof MailTransportFailure ? error : new MailTransportFailure('unknown', error instanceof Error ? error.message : String(error));
        const status = failure.kind === 'permanent' || failure.kind === 'auth' || failure.kind === 'disabled' ? 'rejected' : 'unknown';
        const saved = await tx.execute<any>(sql`UPDATE public.platform_mail_messages SET status = ${status}, diagnostic_kind = ${failure.kind},
          diagnostic_message = ${failure.message},
          unknown = CASE WHEN ${status} = 'unknown' THEN (SELECT jsonb_agg(value->>'email') FROM jsonb_array_elements(recipients)) ELSE '[]'::jsonb END,
          updated_at = pg_catalog.clock_timestamp() WHERE id = ${message.id} RETURNING *`);
        this.logger.warn({ reference: message.reference, kind: failure.kind }, 'mail transport did not confirm delivery');
        // Job errors must not reintroduce SMTP PII after erasure clears its row.
        const permanentError = status === 'rejected' ? failure.kind === 'permanent' && failure.message === 'Mail attachment is unavailable'
          ? 'Mail attachment is unavailable' : 'Mail transport rejected delivery' : undefined;
        return { result: diagnostic(values(saved.rows[0])), permanentError };
      }
    });
    if (outcome.permanentError) throw new PermanentJobError(outcome.permanentError);
    // SMTP may have received DATA before a timeout/socket failure. Unknown is
    // retained and never automatically retried.
    return outcome.result;
  }
  /** A recovered queue job never reclaims an abandoned SMTP attempt. */
  async deliverQueued(id: string, expected: { id: string; version: number }): Promise<MailDiagnostic> {
    const stranded = await this.markSendingUnknown(id);
    if (stranded) return stranded;
    return this.deliver(id, expected);
  }
  /** Whether this deployment has a real transport at all; a disabled one never queues work. */
  get enabled(): boolean { return !(this.transport instanceof DisabledTransport); }
  async close(): Promise<void> { await this.transport.close?.(); }
  async healthCheck(): Promise<{ enabled: boolean }> {
    if (this.transport instanceof DisabledTransport) return { enabled: false };
    await this.transport.verify?.();
    return { enabled: true };
  }

  private async create(tx: Tx, request: MailSendRequest): Promise<StoredMessage> {
    assertRequest(request);
    const body = render(request);
    const hash = requestHash(this.sender, request, body);
    const inserted = await tx.execute<any>(sql`INSERT INTO public.platform_mail_messages
      (id, reference, template_id, template_version, locale, sender, recipients, subject, html, text_body, attachments, request_hash, message_id, status)
      VALUES (${randomUUID()}, ${request.reference}, ${request.template.id}, ${request.template.version}, ${request.locale ?? null}, ${this.sender},
        ${JSON.stringify(request.to)}::jsonb, ${body.subject}, ${body.html}, ${body.text}, ${JSON.stringify(request.attachments ?? [])}::jsonb, ${hash}, ${messageId(this.storeId, request.reference)}, 'pending')
      ON CONFLICT (reference) DO NOTHING RETURNING *`);
    if (inserted.rows[0]) return values(inserted.rows[0]);
    const existing = await tx.execute<any>(sql`SELECT * FROM public.platform_mail_messages WHERE reference = ${request.reference}`);
    if (!existing.rows[0]) throw new Error('Mail reference conflict could not be read');
    if (existing.rows[0].status === 'erased') return values(existing.rows[0]);
    if (existing.rows[0].request_hash !== hash) throw new Error('Mail reference already exists with different immutable content');
    return values(existing.rows[0]);
  }
  private async markSendingUnknown(id: string): Promise<MailDiagnostic | undefined> {
    const stranded = await this.database.pool.query(`UPDATE public.platform_mail_messages
      SET status = 'unknown', diagnostic_kind = 'unknown', diagnostic_message = 'Previous attempt stopped after claiming SMTP delivery',
          unknown = (SELECT jsonb_agg(value->>'email') FROM jsonb_array_elements(recipients)), updated_at = pg_catalog.clock_timestamp()
      WHERE id = $1 AND status = 'sending' RETURNING *`, [id]);
    return stranded.rows[0] ? diagnostic(values(stranded.rows[0])) : undefined;
  }
  private async inTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return this.database.transaction(tx => fn(tx));
  }
}

export function createMailJob(service: () => MailService | undefined): JobHandler {
  return async raw => {
    const payload = mailSendJobPayload.parse(raw);
    const mail = service();
    if (!mail) throw new PermanentJobError('Mail service is not initialized');
    await mail.deliverQueued(payload.messageId, { id: payload.templateId, version: payload.templateVersion });
  };
}
