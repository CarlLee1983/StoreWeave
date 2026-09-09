/** 追問：croner／cronosjs 有沒有「任意時間點的上一次應執行時間」這條純計算路徑。 */
import { Cron } from 'croner';
import { CronosExpression } from 'cronosjs';
import { CronExpressionParser } from 'cron-parser';

const anchor = new Date('2026-09-08T03:00:00Z');
const c = new Cron('0 0 * * *', { timezone: 'Asia/Taipei' });

console.log('croner previousRun(anchor) :', c.previousRun(anchor));
console.log('croner previousRun()       :', c.previousRun());
console.log('croner 以 startAt 反推      :',
  new Cron('0 0 * * *', { timezone: 'Asia/Taipei', startAt: new Date('2026-09-06T00:00:00Z') })
    .previousRun(anchor));
console.log('croner 公開方法             :',
  Object.getOwnPropertyNames(Object.getPrototypeOf(c)).sort().join(', '));

const e = CronosExpression.parse('0 0 * * *', { timezone: 'Asia/Taipei' });
console.log('cronosjs 公開方法           :',
  Object.getOwnPropertyNames(Object.getPrototypeOf(e)).sort().join(', '));

const it = CronExpressionParser.parse('0 0 * * *', { currentDate: anchor, tz: 'Asia/Taipei' });
console.log('cron-parser 連續 prev       :',
  [it.prev().toISOString(), it.prev().toISOString(), it.prev().toISOString()].join(' | '));
