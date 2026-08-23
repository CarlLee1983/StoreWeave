import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '../src/errors';
import { SLOW_CALL_MS, logBusCall } from '../src/timing';
import type { Logger } from '../src/logger';

/** 工單 53 的 level 規則。整合測試打得到快與 4xx，慢與 5xx 只能在這裡驗。 */
function fakeLogger() {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => logger as unknown as Logger,
  };
  return logger;
}

describe('logBusCall', () => {
  it('Command 成功走 info，Query 成功走 debug', () => {
    const logger = fakeLogger();
    logBusCall(logger as unknown as Logger, 'command', { latencyMs: 5, fields: { owner: 'catalog' } });
    logBusCall(logger as unknown as Logger, 'query', { latencyMs: 5 });

    expect(logger.info).toHaveBeenCalledWith({ owner: 'catalog', latencyMs: 5 }, 'command executed');
    expect(logger.debug).toHaveBeenCalledWith({ latencyMs: 5 }, 'query executed');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('慢的一律升到 warn——那正是要在預設 level 看見的東西', () => {
    const logger = fakeLogger();
    logBusCall(logger as unknown as Logger, 'query', { latencyMs: SLOW_CALL_MS });
    logBusCall(logger as unknown as Logger, 'command', { latencyMs: SLOW_CALL_MS + 1 });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map(([, msg]) => msg)).toEqual(['slow query executed', 'slow command executed']);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('4xx 失敗停在 debug：那是呼叫端的問題，吵不起來才有意義', () => {
    const logger = fakeLogger();
    logBusCall(logger as unknown as Logger, 'query', { latencyMs: 3, error: PlatformError.notFound('Product', 'x') });

    expect(logger.debug).toHaveBeenCalledWith({ latencyMs: 3, code: 'NOT_FOUND' }, 'query failed');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('5xx 與不是 PlatformError 的例外都走 error——與 HTTP 那層的 filter 對齊', () => {
    const logger = fakeLogger();
    logBusCall(logger as unknown as Logger, 'command', { latencyMs: 3, error: PlatformError.internal('boom') });
    logBusCall(logger as unknown as Logger, 'query', { latencyMs: 3, error: new TypeError('undefined is not a function') });

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    // 不認得的例外仍要有一個 code，否則日誌上那一行看不出是什麼。
    expect(logger.error.mock.calls[1][0]).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('慢的 5xx 停在 error，不會被降級成 warn', () => {
    const logger = fakeLogger();
    logBusCall(logger as unknown as Logger, 'command', { latencyMs: SLOW_CALL_MS + 10, error: PlatformError.internal('boom') });

    expect(logger.error).toHaveBeenCalledWith({ latencyMs: SLOW_CALL_MS + 10, code: 'INTERNAL_ERROR' }, 'slow command failed');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('慢的 4xx 也升到 warn——慢才是這裡要抓的東西', () => {
    const logger = fakeLogger();
    logBusCall(logger as unknown as Logger, 'query', { latencyMs: SLOW_CALL_MS, error: PlatformError.validation('bad') });

    expect(logger.warn).toHaveBeenCalledWith({ latencyMs: SLOW_CALL_MS, code: 'VALIDATION_ERROR' }, 'slow query failed');
  });
});
