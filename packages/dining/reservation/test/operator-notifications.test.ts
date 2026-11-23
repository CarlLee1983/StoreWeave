import { describe, expect, it } from 'vitest';
import { listDiningRequestNotificationsQuery, resendDiningRequestEmailCommand } from '../src/operator-notifications';

describe('Dining operator notification contract', () => {
  const number = 'DR-0123456789ABCDEF0123';

  it('scopes delivery evidence to a Dining request and exposes only delivery metadata', () => {
    expect(listDiningRequestNotificationsQuery.input.safeParse({ number }).success).toBe(true);
    expect(listDiningRequestNotificationsQuery.input.safeParse({ number, reference: 'any-reference' }).success).toBe(false);

    const item = { event: 'accepted', id: 'baf07b45-8365-4cb2-a332-73046322d3ef', status: 'unknown',
      attempts: 1, sentAt: null, updatedAt: new Date() };
    expect(listDiningRequestNotificationsQuery.output.parse({ items: [item] })).toEqual({ items: [item] });
    expect(listDiningRequestNotificationsQuery.output.safeParse({
      items: [{ ...item, recipient: 'private@example.test' }],
    }).success).toBe(false);
  });

  it('requires the reviewed attempt count and never accepts a caller-supplied reference or actor', () => {
    const input = { number, event: 'received',
      deliveryId: 'baf07b45-8365-4cb2-a332-73046322d3ef', operationId: '19a6e06d-646f-4a20-8065-a33875eab3c3',
      expectedAttempts: 1 };
    const schema = resendDiningRequestEmailCommand.input;
    expect(schema.parse(input)).toEqual({ ...input, acknowledgeDuplicateRisk: false });
    for (const invalid of [
      { event: 'updated' }, { expectedAttempts: -1 }, { operationId: undefined },
      { acknowledgeDuplicateRisk: 'true' }, { reference: 'other-reference' }, { actorId: 'another-user' },
    ]) {
      expect(schema.safeParse({ ...input, ...invalid }).success).toBe(false);
    }
  });
});
