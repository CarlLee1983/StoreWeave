/**
 * 追問：非整點位移與 30 分鐘 DST 的時區。croner 自己算位移，cron-parser 走 luxon／Intl，
 * 這一組才分得出「手寫時區數學」與「查 tz 資料庫」的差別。
 */
import { CronExpressionParser } from 'cron-parser';
import { Cron } from 'croner';

const cases = [
  // Lord Howe：DST 只移動 30 分鐘，2026-10-04 02:00 → 02:30
  ['Australia/Lord_Howe', '30 2 * * *', new Date('2026-10-03T00:00:00Z'), 3],
  // Chatham：+12:45／+13:45，DST 2026-09-27 02:45 → 03:45
  ['Pacific/Chatham', '0 3 * * *', new Date('2026-09-26T00:00:00Z'), 3],
  // Teheran 已於 2022 廢除 DST，測 tz 資料是否為新版
  ['Asia/Tehran', '30 0 * * *', new Date('2026-03-20T00:00:00Z'), 3],
  // 尼泊爾 +05:45，非整點但無 DST
  ['Asia/Kathmandu', '0 0 * * *', new Date('2026-09-08T00:00:00Z'), 2],
];

const show = (d, tz) =>
  d
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false,
      }).format(d) + `Z=${d.toISOString()}`
    : 'null';

for (const [tz, expr, from, n] of cases) {
  console.log(`\n${tz}  ${expr}  from=${from.toISOString()}`);
  const it = CronExpressionParser.parse(expr, { currentDate: from, tz });
  const a = Array.from({ length: n }, () => it.next().toDate());
  const b = new Cron(expr, { timezone: tz }).nextRuns(n, from);
  console.log('  cron-parser:', a.map((d) => show(d, tz)).join(' | '));
  console.log('  croner     :', b.map((d) => show(d, tz)).join(' | '));
  const same = a.every((d, i) => d.getTime() === b[i]?.getTime());
  console.log(`  一致：${same ? 'yes' : 'NO — 兩套算出不同結果'}`);
}
