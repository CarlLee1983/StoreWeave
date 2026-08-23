import { describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../src/logger';

/**
 * 測試用的 logger 走的是正式那條 `createLogger()`。
 * 手刻一個假 logger 驗不到這兩件事，而它們正是這一層存在的理由。
 */
describe('createMemoryLogger', () => {
  it('機密欄位在寫出去之前就被遮掉', () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ token: 'super-secret', nested: { apiKey: 'also-secret', keep: 1 } }, 'wrote');

    expect(lines[0].fields).toMatchObject({ token: '[redacted]', nested: { apiKey: '[redacted]', keep: 1 } });
    expect(JSON.stringify(lines[0])).not.toContain('super-secret');
  });

  it('child() 的 binding 跟著每一行走，而且一樣過 redact', () => {
    const { logger, lines } = createMemoryLogger();
    logger.child({ query: 'commerce.catalog.searchProducts', password: 'p' }).debug({ latencyMs: 3 }, 'query executed');

    expect(lines[0].fields).toMatchObject({ query: 'commerce.catalog.searchProducts', password: '[redacted]', latencyMs: 3 });
    expect(lines[0].level).toBe('debug');
  });

  it('level 擋得掉的那一行不會出現', () => {
    const { logger, lines } = createMemoryLogger({ level: 'info' });
    logger.debug({ latencyMs: 1 }, 'query executed');
    logger.warn({ latencyMs: 600 }, 'slow query executed');

    expect(lines.map((l) => l.msg)).toEqual(['slow query executed']);
  });
});
