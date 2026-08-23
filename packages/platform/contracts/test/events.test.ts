import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent, EVENT_NAME_PATTERN } from '@storeweave/contracts';

describe('defineEvent', () => {
  it('從名稱推出版本號', () => {
    const e = defineEvent({ name: 'shop.thing.happened.v1', payload: z.object({}) });
    expect(e.version).toBe(1);
  });

  it('拒絕沒有版本後綴的名稱', () => {
    expect(() => defineEvent({ name: 'commerce.order.paid', payload: z.object({}) })).toThrow(/Invalid event name/);
  });

  it('事件名稱格式符合平台慣例', () => {
    for (const name of ['commerce.product.created.v1', 'commerce.inventory.adjusted.v1', 'commerce.order.cancelled.v2']) {
      expect(EVENT_NAME_PATTERN.test(name)).toBe(true);
    }
    expect(EVENT_NAME_PATTERN.test('Commerce.Order.Paid.v1')).toBe(false);
  });

  it('不限制 bounded context 必須是 commerce', () => {
    expect(EVENT_NAME_PATTERN.test('cms.post.published.v1')).toBe(true);
    expect(EVENT_NAME_PATTERN.test('booking.slot.reserved.v1')).toBe(true);
    const e = defineEvent({ name: 'cms.post.published.v1', payload: z.object({}) });
    expect(e.version).toBe(1);
  });
});
