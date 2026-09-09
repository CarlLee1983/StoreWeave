/**
 * B05 cron／timezone 選型探針。
 *
 * 只回答一件事：哪一個成熟套件在 StoreWeave 需要的時區與 DST 情境下，
 * 給得出可重現、可注入時鐘的 occurrence 序列。不建立資料庫、不碰 production 程式碼。
 *
 * 案例對應計畫 §B05 出口：Asia/Taipei 午夜、具 DST 時區的 spring-forward／fall-back、
 * 停機補跑列舉，以及 occurrence 身分所需的「上一次應執行時間」。
 */
import { CronExpressionParser } from 'cron-parser';
import { Cron } from 'croner';
import { CronosExpression } from 'cronosjs';

const fmt = (d, tz) =>
  d === null || d === undefined
    ? 'null'
    : new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(d)
        .replace(', ', ' ') + ` (${d.toISOString()})`;

const nextN = {
  'cron-parser': (expr, tz, from, n) => {
    const it = CronExpressionParser.parse(expr, { currentDate: from, tz });
    return Array.from({ length: n }, () => it.next().toDate());
  },
  croner: (expr, tz, from, n) => new Cron(expr, { timezone: tz }).nextRuns(n, from),
  cronosjs: (expr, tz, from, n) =>
    CronosExpression.parse(expr, { timezone: tz }).nextNDates(from, n),
};

const prevOne = {
  'cron-parser': (expr, tz, from) =>
    CronExpressionParser.parse(expr, { currentDate: from, tz }).prev().toDate(),
  croner: (expr, tz, from) => new Cron(expr, { timezone: tz }).previousRun(from),
  cronosjs: () => undefined, // 沒有公開的 previous API
};

const cases = [
  {
    id: 'A. Asia/Taipei 每日午夜',
    expr: '0 0 * * *',
    tz: 'Asia/Taipei',
    from: new Date('2026-09-08T03:00:00Z'),
    n: 3,
    expect: '每天 Taipei 00:00，即 UTC 16:00（前一日）',
  },
  {
    id: 'B. New York spring-forward，02:30 當天不存在',
    expr: '30 2 * * *',
    tz: 'America/New_York',
    from: new Date('2026-03-07T12:00:00Z'),
    n: 3,
    expect: '03-08 的 02:30 不存在；套件是跳過、順延到 03:30，還是丟出兩次',
  },
  {
    id: 'C. New York fall-back，01:30 當天出現兩次',
    expr: '30 1 * * *',
    tz: 'America/New_York',
    from: new Date('2026-10-31T12:00:00Z'),
    n: 3,
    expect: '11-01 的 01:30 有 EDT／EST 兩個瞬間；應只排一次',
  },
  {
    id: 'D. 停機補跑列舉：Taipei 午夜，跨三天停機',
    expr: '0 0 * * *',
    tz: 'Asia/Taipei',
    from: new Date('2026-09-01T00:00:00Z'),
    n: 4,
    expect: '從過去的時間點可完整列舉錯過的 occurrence，用來做有上限追補',
  },
  {
    id: 'E. 每 15 分鐘（既有 everyMs 對應）',
    expr: '*/15 * * * *',
    tz: 'Asia/Taipei',
    from: new Date('2026-09-08T03:07:00Z'),
    n: 3,
    expect: '固定間隔的既有工作可用同一條路徑表達',
  },
];

for (const c of cases) {
  console.log(`\n## ${c.id}`);
  console.log(`   expr=${c.expr} tz=${c.tz} from=${c.from.toISOString()}`);
  console.log(`   期望：${c.expect}`);
  for (const lib of Object.keys(nextN)) {
    try {
      const runs = nextN[lib](c.expr, c.tz, c.from, c.n);
      console.log(`   ${lib.padEnd(12)} next: ${runs.map((d) => fmt(d, c.tz)).join(' | ')}`);
    } catch (error) {
      console.log(`   ${lib.padEnd(12)} next: ERROR ${error.message}`);
    }
  }
}

console.log('\n## F. 上一次應執行時間（occurrence 身分 / dedupe key 需要）');
const anchor = new Date('2026-09-08T03:00:00Z');
for (const lib of Object.keys(prevOne)) {
  try {
    const d = prevOne[lib]('0 0 * * *', 'Asia/Taipei', anchor);
    console.log(`   ${lib.padEnd(12)} prev: ${d === undefined ? '不支援' : fmt(d, 'Asia/Taipei')}`);
  } catch (error) {
    console.log(`   ${lib.padEnd(12)} prev: ERROR ${error.message}`);
  }
}

console.log('\n## G. 時鐘可注入性（不得依賴行程真實時間）');
console.log('   cron-parser  options.currentDate：純計算，無內部 timer');
console.log('   croner       nextRuns(n, from)：純計算，但套件本體同時是 in-process scheduler');
console.log('   cronosjs     nextNDates(from, n)：純計算，另附 CronosTask timer');

console.log('\n## H. 相依與體積');
for (const lib of ['cron-parser', 'croner', 'cronosjs']) {
  const pkg = JSON.parse(
    await (await import('node:fs/promises')).readFile(`./node_modules/${lib}/package.json`, 'utf8'),
  );
  console.log(
    `   ${lib.padEnd(12)} v${pkg.version} deps=${JSON.stringify(pkg.dependencies ?? {})}`,
  );
}
