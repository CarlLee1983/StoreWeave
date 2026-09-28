import { describe, expect, it } from 'vitest';
import { diningConfigDefinition } from '@storeweave/release-dining/config';

const valid = {
  version: 1,
  store: { id: 'dining-test', name: 'Dining Test' },
  database: { url: 'postgres://dining.invalid/test' },
  dining: {
    reservationPiiRetentionDays: 30,
    publicRequestRateLimits: {
      source: { maxSubmissions: 6, windowSeconds: 60 },
      recipient: { maxSubmissions: 3, windowSeconds: 3600 },
    },
  },
};

describe('Dining release configuration', () => {
  it('exposes the validated Dining policy through the release config definition', () => {
    const config = diningConfigDefinition.schema.parse(valid);
    expect(config.dining).toEqual(valid.dining);
  });

  it.each([undefined, 0, -1, 1.5, '30', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    'rejects invalid retention days: %s', retentionDays => {
      expect(diningConfigDefinition.schema.safeParse({
        ...valid, dining: { ...valid.dining, reservationPiiRetentionDays: retentionDays },
      }).success).toBe(false);
    },
  );

  it.each(['source', 'recipient'] as const)('requires a valid %s submission limit and window', side => {
    const limits = valid.dining.publicRequestRateLimits;
    expect(diningConfigDefinition.schema.safeParse({
      ...valid, dining: { ...valid.dining, publicRequestRateLimits: { ...limits, [side]: undefined } },
    }).success).toBe(false);
    for (const field of ['maxSubmissions', 'windowSeconds'] as const) {
      for (const invalid of [undefined, 0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
        const result = diningConfigDefinition.schema.safeParse({
          ...valid,
          dining: {
            ...valid.dining,
            publicRequestRateLimits: { ...limits, [side]: { ...limits[side], [field]: invalid } },
          },
        });
        expect(result.success, `${side}.${field} accepted ${String(invalid)}`).toBe(false);
      }
    }
  });

  it('requires explicit Dining policy and rejects misspelled controls', () => {
    expect(diningConfigDefinition.schema.safeParse({ ...valid, dining: undefined }).success).toBe(false);
    expect(diningConfigDefinition.schema.safeParse({
      ...valid, dining: { ...valid.dining, publicRequestRateLimits: undefined },
    }).success).toBe(false);
    expect(diningConfigDefinition.schema.safeParse({
      ...valid, dining: { ...valid.dining, reservationPiiRetentionDay: 30 },
    }).success).toBe(false);
    expect(diningConfigDefinition.schema.safeParse({
      ...valid, dining: { ...valid.dining, publicRequestRateLimits: {
        ...valid.dining.publicRequestRateLimits, source: { maxSubmissions: 6, windowSecond: 60 },
      } },
    }).success).toBe(false);
  });
});
