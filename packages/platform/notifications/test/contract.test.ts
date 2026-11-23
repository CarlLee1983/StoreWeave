import { describe, expect, it } from 'vitest';
import { maskEmailsIn, maskRecipient, resendEmailInput, sendNotificationInput } from '../src/index';

const template = {
  id: 'account.welcome', version: 1,
  email: { subject: 'Hi {name}', html: '<p>Hi {name}</p>', text: 'Hi {name}' },
  inapp: { title: 'Hi {name}', body: 'Welcome, {name}' },
};

describe('notification request contract', () => {
  it('requires the content and the address each requested channel needs', () => {
    const emailWithoutAddress = sendNotificationInput.safeParse({
      reference: 'welcome:1', channels: ['email'], recipient: { userId: 'user:1' },
      template: { id: template.id, version: 1, email: template.email }, variables: { name: 'A' },
    });
    expect(emailWithoutAddress.success).toBe(false);
    expect(emailWithoutAddress.error?.issues.map(issue => issue.path.join('.'))).toContain('recipient.email');

    const inappWithoutContent = sendNotificationInput.safeParse({
      reference: 'welcome:2', channels: ['inapp'], recipient: { userId: 'user:1' },
      template: { id: template.id, version: 1, email: template.email }, variables: { name: 'A' },
    });
    expect(inappWithoutContent.success).toBe(false);
    expect(inappWithoutContent.error?.issues.map(issue => issue.path.join('.'))).toContain('template.inapp');
  });

  it('accepts both channels at once and rejects a repeated channel', () => {
    const both = sendNotificationInput.safeParse({
      reference: 'welcome:3', channels: ['email', 'inapp'],
      recipient: { userId: 'user:1', email: 'a@example.test' }, template, variables: { name: 'A' },
    });
    expect(both.success).toBe(true);

    const repeated = sendNotificationInput.safeParse({
      reference: 'welcome:4', channels: ['email', 'email'],
      recipient: { userId: 'user:1', email: 'a@example.test' }, template, variables: { name: 'A' },
    });
    expect(repeated.success).toBe(false);
  });
});

describe('recipient masking', () => {
  it('keeps the domain, fixes the mask width, and hides a single-character local part', () => {
    expect(maskRecipient('buyer@example.test')).toBe('b***@example.test');
    expect(maskRecipient('a@example.test')).toBe('***@example.test');
    expect(maskRecipient('not-an-address')).toBe('***');
  });

  it('masks addresses a transport quoted back inside a diagnostic', () => {
    expect(maskEmailsIn('550 5.1.1 <buyer@example.test>: recipient rejected'))
      .toBe('550 5.1.1 <b***@example.test>: recipient rejected');
    expect(maskEmailsIn(null)).toBeNull();
  });
});

describe('operator email resend contract', () => {
  it('requires a stable operation and reviewed attempt count, and keeps actor identity outside the payload', () => {
    const input = { deliveryId: 'aaff9351-b4f5-4a22-8788-9740c1ac0137',
      operationId: 'ff3895e9-6a13-4e47-a7ba-5af49b4c582a', expectedAttempts: 3 };
    expect(resendEmailInput.parse(input)).toMatchObject({ acknowledgeDuplicateRisk: false });
    expect(resendEmailInput.safeParse({ ...input, acknowledgeDuplicateRisk: true }).success).toBe(true);
    expect(resendEmailInput.safeParse({ ...input, acknowledgeDuplicateRisk: 'true' }).success).toBe(false);
    expect(resendEmailInput.safeParse({ ...input, actorId: 'spoofed' }).success).toBe(false);
    expect(resendEmailInput.safeParse({ ...input, expectedAttempts: -1 }).success).toBe(false);
    expect(resendEmailInput.safeParse({ ...input, operationId: undefined }).success).toBe(false);
  });
});
