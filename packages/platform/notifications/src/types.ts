import { z } from 'zod';

/**
 * Base notification vocabulary. A recipient is any addressable person — a
 * platform user, or a bare address for someone who has no account here. It is
 * deliberately not a commerce Customer: a base-only release notifies people too.
 */
export const notificationChannel = z.enum(['email', 'inapp']);
export type NotificationChannel = z.infer<typeof notificationChannel>;

/**
 * `unknown` exists because an accepted SMTP conversation that then times out is
 * neither delivered nor safe to replay. It is recorded and left for an operator.
 */
export const notificationDeliveryStatus = z.enum(['pending', 'sent', 'failed', 'skipped', 'unknown']);
export type NotificationDeliveryStatus = z.infer<typeof notificationDeliveryStatus>;

export const notificationRecipient = z.object({
  /** Platform user id — the in-app inbox is addressed by it, never by email. */
  userId: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
}).strict();
export type NotificationRecipient = z.infer<typeof notificationRecipient>;

const inappContent = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
}).strict();

const emailContent = z.object({
  subject: z.string().min(1).max(400),
  html: z.string().min(1),
  text: z.string().min(1),
}).strict();

/**
 * One template carries the content of every channel it supports, so the same
 * notification reads the same way wherever it lands. Version is part of the
 * durable snapshot: editing a template can never rewrite a queued send.
 */
export const notificationTemplate = z.object({
  id: z.string().min(1).max(120),
  version: z.number().int().positive(),
  inapp: inappContent.extend({ translations: z.record(inappContent).optional() }).optional(),
  email: emailContent.extend({ translations: z.record(emailContent).optional() }).optional(),
}).strict();
export type NotificationTemplate = z.infer<typeof notificationTemplate>;

export const sendNotificationInput = z.object({
  /** Caller-owned idempotency identity; re-sending the same reference never delivers twice. */
  reference: z.string().min(1).max(240),
  channels: z.array(notificationChannel).min(1).max(2),
  recipient: notificationRecipient,
  template: notificationTemplate,
  variables: z.record(z.unknown()).optional(),
  locale: z.string().max(35).optional(),
}).strict().superRefine((value, ctx) => {
  const channels = new Set(value.channels);
  if (channels.size !== value.channels.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channels'], message: 'channels must be distinct' });
  }
  if (channels.has('email')) {
    if (!value.template.email) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['template', 'email'], message: 'required for the email channel' });
    if (!value.recipient.email) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient', 'email'], message: 'required for the email channel' });
  }
  if (channels.has('inapp')) {
    if (!value.template.inapp) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['template', 'inapp'], message: 'required for the in-app channel' });
    if (!value.recipient.userId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient', 'userId'], message: 'required for the in-app channel' });
  }
});
export type SendNotificationInput = z.infer<typeof sendNotificationInput>;

export const notificationDeliveryDto = z.object({
  id: z.string().uuid(),
  channel: notificationChannel,
  status: notificationDeliveryStatus,
  attempts: z.number().int().nonnegative(),
  /** The channel's own receipt — a mail reference, never a provider secret. */
  externalRef: z.string().nullable(),
  lastError: z.string().nullable(),
  sentAt: z.coerce.date().nullable(),
  readAt: z.coerce.date().nullable(),
});
export type NotificationDeliveryDto = z.infer<typeof notificationDeliveryDto>;

export const notificationDto = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().positive(),
  createdAt: z.coerce.date(),
  deliveries: z.array(notificationDeliveryDto),
});
export type NotificationDto = z.infer<typeof notificationDto>;

export const listInboxInput = z.object({
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

export const inboxItemDto = z.object({
  id: z.string().uuid(),
  notificationId: z.string().uuid(),
  reference: z.string(),
  templateId: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.coerce.date(),
  readAt: z.coerce.date().nullable(),
});
export type InboxItemDto = z.infer<typeof inboxItemDto>;

export const listInboxOutput = z.object({
  items: z.array(inboxItemDto),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});

export const markInboxReadInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
}).strict();

export const markInboxReadOutput = z.object({ updated: z.number().int().nonnegative(), readAt: z.coerce.date() });

export const listDeliveriesInput = z.object({
  channel: notificationChannel.optional(),
  status: notificationDeliveryStatus.optional(),
  reference: z.string().max(240).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

/**
 * Operator-visible evidence. Recipients are masked and the rendered body is
 * absent: the question this view answers is "did it go out, and why not".
 */
export const deliveryEvidenceDto = z.object({
  id: z.string().uuid(),
  notificationId: z.string().uuid(),
  reference: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().positive(),
  channel: notificationChannel,
  status: notificationDeliveryStatus,
  attempts: z.number().int().nonnegative(),
  recipientMasked: z.string(),
  externalRef: z.string().nullable(),
  lastError: z.string().nullable(),
  sentAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type DeliveryEvidenceDto = z.infer<typeof deliveryEvidenceDto>;

export const listDeliveriesOutput = z.object({ items: z.array(deliveryEvidenceDto), total: z.number().int().nonnegative() });
