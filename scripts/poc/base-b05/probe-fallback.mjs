/**
 * croner 10.0.1 的 `previousRuns` 在哪些情況會丟 TypeError。
 *
 * 這決定了 `backwardByForwardScan` fallback 什麼時候會被走到，也就是那份快取的
 * 正確性有沒有實際後果。結論：同一個運算式會**隨 `from` 與 `count` 而變**——
 * `0 0 29 2 *` 在 count=1、from 剛好在 occurrence 之後時正常，其餘皆丟。
 * 所以 fallback 不是罕見路徑，`occurrencesBetween`（count=1000）每一輪都會走到。
 *
 * 執行：node scripts/poc/base-b05/probe-fallback.mjs
 */
import { Cron } from 'croner';

const cron = new Cron('0 0 29 2 *', { timezone: 'Asia/Taipei' });
for (const count of [1, 2, 1000]) {
  for (const from of ['2028-02-28T06:00:01.000Z', '2028-02-28T17:00:01.000Z']) {
    try {
      const runs = cron.previousRuns(count, new Date(from));
      console.log(count, from, '-> OK', runs.length, runs[0]?.toISOString());
    } catch {
      console.log(count, from, '-> THREW');
    }
  }
}
