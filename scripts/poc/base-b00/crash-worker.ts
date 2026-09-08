import { Database } from '../../../packages/platform/db/src/client';
import { JobQueue } from '../../../packages/platform/jobs/src/jobs';
import { PgBoss } from 'pg-boss';

const connectionString = process.env.B00_PG_URL;
if (!connectionString) throw new Error('B00_PG_URL is required');
if (process.argv[2] === 'current') {
  const database = new Database({ url: connectionString });
  const jobs = await database.transaction(tx => new JobQueue().claim(tx, 'crashed-owner', 1, ['poc.crash']));
  process.stdout.write(`${JSON.stringify({ claimed: jobs[0]?.id })}\n`);
} else {
  const boss = new PgBoss({ connectionString, schema: 'b00_boss', supervise: false, schedule: false });
  boss.on('error', error => { throw error; });
  await boss.start();
  const jobs = await boss.fetch('poc-crash');
  process.stdout.write(`${JSON.stringify({ claimed: jobs[0]?.id })}\n`);
}
// The parent kills this actual process after the committed claim, before acknowledgement.
setInterval(() => {}, 1000);
