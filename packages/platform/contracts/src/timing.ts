import type { Logger } from './logger';
import { PlatformError } from './errors';

/**
 * 達到這個毫秒數就當成「慢」（比較是 `>=`），在預設 level 就看得見（工單 53）。
 *
 * 寫死一個常數而不是開設定：目前沒有任何一座部署提過不同的門檻，
 * 而 500ms 對單站商店的一支 Query 已經是明顯不對勁的量級。
 * 真的有人需要別的數字時再變成設定，那時才知道要開成什麼形狀。
 */
export const SLOW_CALL_MS = 500;

/**
 * 從 `performance.now()` 的起點算到現在，取整數毫秒。
 * 用單調時鐘而不是 `Date.now()`：NTP 校時會讓後者往回跳，
 * 而這個數字要拿來跟門檻比大小。
 */
export function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export interface BusCallOutcome {
  /** 額外附在那一行上的欄位，例如 Command 的 owner。 */
  readonly fields?: Record<string, unknown>;
  readonly latencyMs: number;
  readonly error?: unknown;
}

/**
 * Command / Query 執行完的那一行。兩支 Bus 共用同一份規則，
 * 各寫一次遲早會有一邊漏掉 latencyMs 或選了不同的 level。
 *
 * | | 一般 | 超過 SLOW_CALL_MS |
 * | --- | --- | --- |
 * | Command 成功 | info | warn |
 * | Query 成功 | debug | warn |
 * | 失敗 4xx | debug | warn |
 * | 失敗 5xx | error | error |
 *
 * Query 成功停在 debug，是因為它的量級是「渲染次數」——前台每畫一次頁面就打好幾支，
 * 逐次 info 會把日誌淹到沒有人願意讀。慢的那幾筆才是要看的，所以它們升到 warn。
 * 4xx 同理：那是呼叫端的問題，不是這座部署的問題，吵不起來才有意義。
 *
 * 5xx 走 error，與 HTTP 那層的 exception filter 對齊：Bus 是所有通道的共同咽喉，
 * 以 `level >= error` 設告警的部署，不該只抓到走 REST 的那一半而漏掉 worker 與 CLI。
 */
export function logBusCall(
  logger: Logger,
  kind: 'command' | 'query',
  outcome: BusCallOutcome,
): void {
  const slow = outcome.latencyMs >= SLOW_CALL_MS;
  const fields = { ...outcome.fields, latencyMs: outcome.latencyMs };

  if (outcome.error === undefined) {
    const message = `${kind} executed`;
    if (slow) logger.warn(fields, `slow ${message}`);
    else if (kind === 'command') logger.info(fields, message);
    else logger.debug(fields, message);
    return;
  }

  const error = outcome.error;
  const code = error instanceof PlatformError ? error.code : 'INTERNAL_ERROR';
  const serverSide = !(error instanceof PlatformError) || error.httpStatus >= 500;
  const failed = { ...fields, code };
  const message = `${kind} failed`;

  if (serverSide) logger.error(failed, slow ? `slow ${message}` : message);
  else if (slow) logger.warn(failed, `slow ${message}`);
  else logger.debug(failed, message);
}
