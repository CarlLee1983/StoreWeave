/** 追問：表達力與錯誤處理。ADR 0016 當年否決自製 cron 的理由之一就是這些語法。 */
import { CronExpressionParser } from 'cron-parser';
import { Cron } from 'croner';

const tz = 'Asia/Taipei';
const from = new Date('2026-09-08T03:00:00Z');
const exprs = [
  ['每月第一個星期一 09:00', '0 9 * * 1#1'],
  ['每月最後一天 23:00', '0 23 L * *'],
  ['每月最後一個星期五 18:00', '0 18 * * 5L'],
  ['含秒（6 欄）', '15 0 0 * * *'],
  ['非法欄位', '0 99 * * *'],
  ['非法欄數', '0 0 *'],
];

for (const [label, expr] of exprs) {
  const out = [label.padEnd(22), expr.padEnd(14)];
  try {
    const d = CronExpressionParser.parse(expr, { currentDate: from, tz }).next().toDate();
    out.push(`cron-parser=${d.toISOString()}`);
  } catch (error) {
    out.push(`cron-parser=REJECT(${error.message.slice(0, 40)})`);
  }
  try {
    const d = new Cron(expr, { timezone: tz }).nextRun(from);
    out.push(`croner=${d ? d.toISOString() : 'null'}`);
  } catch (error) {
    out.push(`croner=REJECT(${error.message.slice(0, 40)})`);
  }
  console.log(out.join('  '));
}
