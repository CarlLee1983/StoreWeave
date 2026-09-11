import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { checkPlatformCompatibility } from '@storeweave/extension-sdk';
import type { Runtime } from './runtime';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface DependencyHealth {
  status: 'ok' | 'degraded' | 'down';
  checks: Check[];
}

/**
 * Stable machine-readable operational counters. Unlike the human-facing
 * health `detail` strings, these fields are intended for a monitoring agent
 * to collect and turn into its own alert policy.
 */
export interface OperationalMetrics {
  status: DependencyHealth['status'];
  outbox: { pending: number; dead: number; oldestPendingAgeSeconds: number | null };
  jobs: { pending: number; running: number; dead: number; quarantined: number };
  worker: { lastSeenAgeSeconds: number | null };
  scheduler: { total: number; paused: number; skippedCatchup: number; skippedPaused: number; skippedOverlap: number };
  mail: { enabled: boolean; pending: number; partial: number; unknown: number; rejected: number };
  storage: { available: boolean };
}

export async function liveness(): Promise<{ status: 'ok'; uptimeSeconds: number }> {
  return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
}

/** Ready = 可以接受流量：資料庫連得上且沒有未套用的 migration。 */
export async function readiness(runtime: Runtime): Promise<DependencyHealth> {
  const checks: Check[] = [];
  const ping = await runtime.database.ping();
  if (!ping.ok) {
    // readiness 是公開端點：連線錯誤原文通常帶有主機名與使用者名，只進 log。
    runtime.logger.error({ error: ping.error }, 'postgres readiness check failed');
  }
  checks.push({
    name: 'postgres',
    status: ping.ok ? 'pass' : 'fail',
    detail: ping.ok ? `${ping.latencyMs}ms` : 'connection failed; see server logs',
  });

  if (ping.ok) {
    const status = await runtime.migrationStatus();
    if (status.releaseCurrent === false) checks.push({ name: 'release activation', status: 'fail', detail: 'run the release CLI migrate command' });
    checks.push({
      name: 'migrations',
      status: status.pending.length === 0 ? 'pass' : 'fail',
      detail: status.pending.length === 0 ? `${status.applied.length} applied` : `${status.pending.length} pending`,
    });
  }
  return summarize(checks);
}

/** 依賴健康：資料庫、Outbox / Queue 積壓、Worker 心跳、各 Provider、各 Extension。 */
export async function dependencies(runtime: Runtime): Promise<DependencyHealth> {
  const checks: Check[] = [];
  const ping = await runtime.database.ping();
  if (!ping.ok) {
    // 連線錯誤原文通常帶有主機名與使用者名，而這個端點是公開的：原文只進 log。
    runtime.logger.error({ error: ping.error }, 'postgres health check failed');
  }
  checks.push({
    name: 'postgres',
    status: ping.ok ? 'pass' : 'fail',
    detail: ping.ok ? `${ping.latencyMs}ms` : 'connection failed; see server logs',
  });
  if (!ping.ok) return summarize(checks);

  checks.push(await storageHealthCheck(runtime, 'warn'));
  checks.push(await mailHealthCheck(runtime, 'warn'));

  const outbox = await runtime.outbox.stats(runtime.database.db);
  checks.push({
    name: 'outbox',
    status: outbox.dead > 0 ? 'fail' : outbox.pending > 1000 ? 'warn' : 'pass',
    detail: `pending=${outbox.pending} dead=${outbox.dead} oldestPendingAge=${outbox.oldestPendingAgeSeconds ?? 0}s`,
  });

  const jobs = await runtime.jobs.stats(runtime.database.db);
  checks.push({
    name: 'jobs',
    status: (jobs.dead ?? 0) > 0 ? 'warn' : 'pass',
    detail: Object.entries(jobs).map(([k, v]) => `${k}=${v}`).join(' '),
  });

  checks.push(await workerHeartbeatCheck(runtime));

  checks.push(...await providerHealthChecks(runtime, 'warn'));

  for (const ext of runtime.extensions.list()) {
    if (!ext.definition.healthCheck) {
      checks.push({ name: `extension:${ext.id}`, status: 'pass', detail: `v${ext.version}` });
      continue;
    }
    try {
      const result = await ext.definition.healthCheck(ext.context);
      checks.push({ name: `extension:${ext.id}`, status: result.ok ? 'pass' : 'warn', detail: result.message });
    } catch (err) {
      checks.push({ name: `extension:${ext.id}`, status: 'warn', detail: (err as Error).message });
    }
  }

  return summarize(checks);
}

/**
 * The authenticated metrics view intentionally carries counters only: no
 * worker id, provider error, recipient, or storage key can leak into a
 * metrics system. Disabled mail is a normal configuration, not an outage.
 */
export async function operationalMetrics(runtime: Runtime): Promise<OperationalMetrics> {
  const ping = await runtime.database.ping();
  if (!ping.ok) {
    runtime.logger.error({ error: ping.error }, 'postgres metrics check failed');
    let storageAvailable = true;
    try { await runtime.storage.healthCheck(); } catch { storageAvailable = false; }
    // Counters retain a numeric shape while PostgreSQL is unavailable. The
    // down status makes it explicit that zeroes are not sampled queue state.
    return {
      status: 'down',
      outbox: { pending: 0, dead: 0, oldestPendingAgeSeconds: null },
      jobs: { pending: 0, running: 0, dead: 0, quarantined: 0 },
      worker: { lastSeenAgeSeconds: null },
      scheduler: { total: 0, paused: 0, skippedCatchup: 0, skippedPaused: 0, skippedOverlap: 0 },
      mail: { enabled: runtime.config.mail.transport !== 'disabled', pending: 0, partial: 0, unknown: 0, rejected: 0 },
      storage: { available: storageAvailable },
    };
  }
  const [outbox, jobs, schedules, heartbeat, mail] = await Promise.all([
    runtime.outbox.stats(runtime.database.db),
    runtime.jobs.stats(runtime.database.db),
    runtime.recurring.list(runtime.database.db),
    workerHeartbeatAge(runtime),
    mailMetrics(runtime),
  ]);
  let storageAvailable = true;
  try { await runtime.storage.healthCheck(); } catch { storageAvailable = false; }
  const workerAge = heartbeat;
  const workerUnavailable = runtime.config.worker.enabled && workerAge === null;
  const workerStale = runtime.config.worker.enabled && workerAge !== null && workerAge > 60;
  const degraded = !storageAvailable || workerUnavailable || workerStale
    || outbox.pending > 500 || outbox.dead > 0 || (jobs.pending ?? 0) > 500 || (jobs.dead ?? 0) > 0
    || mail.partial > 0 || mail.unknown > 0 || mail.rejected > 0;
  const down = !storageAvailable || workerUnavailable || (runtime.config.worker.enabled && workerAge !== null && workerAge > 300) || outbox.dead > 0;
  return {
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    outbox: { pending: outbox.pending, dead: outbox.dead, oldestPendingAgeSeconds: outbox.oldestPendingAgeSeconds },
    jobs: { pending: jobs.pending ?? 0, running: jobs.running ?? 0, dead: jobs.dead ?? 0, quarantined: jobs.quarantined ?? 0 },
    worker: { lastSeenAgeSeconds: workerAge },
    scheduler: schedules.reduce((total, schedule) => ({
      total: total.total + 1, paused: total.paused + Number(schedule.paused),
      skippedCatchup: total.skippedCatchup + schedule.skippedCatchup,
      skippedPaused: total.skippedPaused + schedule.skippedPaused,
      skippedOverlap: total.skippedOverlap + schedule.skippedOverlap,
    }), { total: 0, paused: 0, skippedCatchup: 0, skippedPaused: 0, skippedOverlap: 0 }),
    mail,
    storage: { available: storageAvailable },
  };
}

/**
 * 宣告要第二因素、卻從來沒有註冊的帳號。ADR 0044 讓這些帳號仍然登得進來
 * （否則新部署完成不了初始化），代價是「宣稱強制 MFA 的部署可以無限期只靠密碼」。
 * 這裡把那個窗口變成營運檢查看得到的數字，而不是只出現在登入回應的一個布林值。
 */
async function mfaEnrolmentCheck(runtime: Runtime): Promise<Check> {
  const rolesRequiringMfa = Object.entries(runtime.roles)
    .filter(([, role]) => role.account && role.account.mfa === 'required')
    .map(([name]) => name);
  if (rolesRequiringMfa.length === 0) {
    return { name: 'operator mfa enrolment', status: 'pass', detail: 'no role requires a second factor' };
  }

  const result = await runtime.database.db.execute<{ pending: string; total: string }>(sql`
    SELECT count(*) FILTER (WHERE m.confirmed_at IS NULL)::text AS pending, count(*)::text AS total
    FROM platform_users u
    LEFT JOIN platform_user_mfa m ON m.user_id = u.id
    WHERE u.status = 'active' AND u.role IN (${sql.join(rolesRequiringMfa.map(role => sql`${role}`), sql`, `)})
  `);
  const pending = Number(result.rows[0]?.pending ?? 0);
  const total = Number(result.rows[0]?.total ?? 0);
  return {
    name: 'operator mfa enrolment',
    status: pending > 0 ? 'warn' : 'pass',
    detail: `${total - pending}/${total} operator accounts have a confirmed second factor`,
  };
}

async function workerHeartbeatCheck(runtime: Runtime): Promise<Check> {
  const res = await runtime.database.db.execute<{ worker_id: string; age: string }>(sql`
    SELECT worker_id, EXTRACT(EPOCH FROM (now() - updated_at))::text AS age
    FROM platform_worker_heartbeat ORDER BY updated_at DESC LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return { name: 'worker', status: 'warn', detail: 'no worker has ever reported in' };
  const age = Math.round(Number(row.age));
  return {
    name: 'worker',
    status: age <= 60 ? 'pass' : age <= 300 ? 'warn' : 'fail',
    detail: `${row.worker_id} last seen ${age}s ago`,
  };
}

async function workerHeartbeatAge(runtime: Runtime): Promise<number | null> {
  const result = await runtime.database.db.execute<{ age: string }>(sql`
    SELECT EXTRACT(EPOCH FROM (now() - max(updated_at)))::text AS age FROM platform_worker_heartbeat
  `);
  const value = result.rows[0]?.age;
  return value === null || value === undefined ? null : Math.max(0, Math.round(Number(value)));
}

async function mailMetrics(runtime: Runtime): Promise<OperationalMetrics['mail']> {
  if (runtime.config.mail.transport === 'disabled') return { enabled: false, pending: 0, partial: 0, unknown: 0, rejected: 0 };
  const result = await runtime.database.db.execute<{ status: string; count: string }>(sql`
    SELECT status, count(*)::text AS count FROM public.platform_mail_messages GROUP BY status
  `);
  const count = (status: string) => Number(result.rows.find(row => row.status === status)?.count ?? 0);
  return { enabled: true, pending: count('pending') + count('sending'), partial: count('partial'), unknown: count('unknown'), rejected: count('rejected') };
}

/**
 * `commerce doctor` 的完整檢查集合。
 * 和 /health/dependencies 共用同一份實作，避免兩邊結論不一致。
 */
export async function doctor(runtime: Runtime, options: { releaseVersion: string; configPath: string }): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ name: 'application version', status: 'pass', detail: `release=${options.releaseVersion} platform=${runtime.platformVersion} node=${process.version}` });
  checks.push({ name: 'configuration schema', status: 'pass', detail: `${options.configPath} (store=${runtime.config.store.id})` });

  const ping = await runtime.database.ping();
  checks.push({ name: 'postgresql connection', status: ping.ok ? 'pass' : 'fail', detail: ping.ok ? `${ping.latencyMs}ms` : ping.error });

  if (ping.ok) {
    const status = await runtime.migrationStatus();
    if (status.releaseCurrent === false) checks.push({ name: 'release activation', status: 'fail', detail: 'run the release CLI migrate command' });
    checks.push({
      name: 'migration status',
      status: status.pending.length === 0 ? 'pass' : 'warn',
      detail: `${status.applied.length} applied, ${status.pending.length} pending${status.pending.length ? `: ${status.pending.map((p) => p.id).join(', ')}` : ''}`,
    });
    checks.push(await workerHeartbeatCheck(runtime));

    const outbox = await runtime.outbox.stats(runtime.database.db);
    checks.push({
      name: 'outbox backlog',
      status: outbox.dead > 0 ? 'fail' : outbox.pending > 500 ? 'warn' : 'pass',
      detail: `pending=${outbox.pending} relayed=${outbox.relayed} dead=${outbox.dead}`,
    });
    const jobs = await runtime.jobs.stats(runtime.database.db);
    checks.push({
      name: 'job queue backlog',
      status: (jobs.dead ?? 0) > 0 ? 'warn' : (jobs.pending ?? 0) > 500 ? 'warn' : 'pass',
      detail: Object.entries(jobs).map(([k, v]) => `${k}=${v}`).join(' '),
    });
    checks.push(await mfaEnrolmentCheck(runtime));
  }

  for (const dir of [runtime.config.paths.dataDir, runtime.config.paths.backupDir]) {
    checks.push(directoryCheck(dir));
  }
  checks.push(await storageHealthCheck(runtime, 'fail'));
  checks.push(await mailHealthCheck(runtime, 'fail'));

  for (const ext of runtime.extensions.list()) {
    const compat = checkPlatformCompatibility(ext.definition.manifest, runtime.platformVersion);
    checks.push({
      name: `extension compatibility: ${ext.id}`,
      status: compat.compatible ? 'pass' : 'fail',
      detail: compat.compatible ? `v${ext.version} requires platform ${ext.platformVersion}` : compat.reason,
    });
  }

  const requiredSecrets = new Set<string>();
  for (const ext of runtime.extensions.list()) {
    for (const s of ext.definition.manifest.requiredSecrets ?? []) requiredSecrets.add(s);
  }
  // 沒有簽章金鑰就沒有密碼重設與驗證信；identity 在啟動時就要求它（ADR 0042）。
  for (const key of runtime.config.security.signingKeys) requiredSecrets.add(key.secretRef);
  if (runtime.config.storage.driver === 's3') {
    requiredSecrets.add(runtime.config.storage.s3!.accessKeyIdRef);
    requiredSecrets.add(runtime.config.storage.s3!.secretAccessKeyRef);
  }
  if (runtime.config.mail?.transport === 'smtp') {
    if (runtime.config.mail.smtp!.usernameRef) requiredSecrets.add(runtime.config.mail.smtp!.usernameRef);
    if (runtime.config.mail.smtp!.passwordRef) requiredSecrets.add(runtime.config.mail.smtp!.passwordRef);
  }
  for (const name of [...requiredSecrets].sort()) {
    checks.push({
      name: `secret present: ${name}`,
      status: runtime.secrets.has(name) ? 'pass' : 'fail',
      detail: runtime.secrets.has(name) ? 'set' : 'missing',
    });
  }

  // `commerce doctor` is a release gate rather than a dashboard. A provider
  // that reports itself unhealthy therefore fails the command, while the HTTP
  // dependency view remains degraded so operators can inspect it during an
  // incident. This also makes every enabled payment provider visible to the
  // same pre-deployment check; no provider receives a special case here.
  checks.push(...await providerHealthChecks(runtime, 'fail'));

  for (const id of ['mcp', 'demo-erp']) {
    const ext = runtime.extensions.find(id);
    if (!ext) {
      checks.push({ name: `extension status: ${id}`, status: 'warn', detail: 'not enabled in this deployment' });
      continue;
    }
    let detail = `v${ext.version}, commands=${ext.commands.length}, queries=${ext.queries.length}, events=${ext.subscribedEvents.length}`;
    let status: CheckStatus = 'pass';
    if (ext.definition.healthCheck) {
      try {
        const result = await ext.definition.healthCheck(ext.context);
        status = result.ok ? 'pass' : 'warn';
        detail = `${detail} — ${result.message ?? ''}`;
      } catch (err) {
        status = 'warn';
        detail = `${detail} — ${(err as Error).message}`;
      }
    }
    checks.push({ name: `extension status: ${id}`, status, detail });
  }

  return checks;
}

async function storageHealthCheck(runtime: Runtime, unhealthyStatus: Extract<CheckStatus, 'warn' | 'fail'>): Promise<Check> {
  try {
    await runtime.storage.healthCheck();
    return { name: 'object storage', status: 'pass', detail: runtime.config.storage.driver };
  } catch (error) {
    runtime.logger.warn({ error: (error as Error).message, driver: runtime.config.storage.driver }, 'object storage health check failed');
    return { name: 'object storage', status: unhealthyStatus, detail: 'unavailable; see server logs' };
  }
}

async function mailHealthCheck(runtime: Runtime, unhealthyStatus: Extract<CheckStatus, 'warn' | 'fail'>): Promise<Check> {
  if (!runtime.mail) return { name: 'mail transport', status: 'pass', detail: 'not present on test double' };
  try {
    const result = await runtime.mail.healthCheck();
    return { name: 'mail transport', status: 'pass', detail: result.enabled ? 'smtp configured and verified' : 'disabled by configuration' };
  } catch (error) {
    runtime.logger.warn({ error: (error as Error).message }, 'mail transport health check failed');
    return { name: 'mail transport', status: unhealthyStatus, detail: 'unavailable; see server logs' };
  }
}

function directoryCheck(dir: string): Check {
  if (!existsSync(dir)) {
    return { name: `storage directory: ${dir}`, status: 'warn', detail: 'does not exist' };
  }
  try {
    accessSync(dir, constants.R_OK | constants.W_OK);
    const mode = (statSync(dir).mode & 0o777).toString(8);
    return { name: `storage directory: ${dir}`, status: 'pass', detail: `readable/writable (mode ${mode})` };
  } catch {
    return { name: `storage directory: ${dir}`, status: 'fail', detail: 'not writable by this user' };
  }
}

async function providerHealthChecks(runtime: Runtime, unhealthyStatus: Extract<CheckStatus, 'warn' | 'fail'>): Promise<Check[]> {
  const checks: Check[] = [];
  for (const provider of runtime.providers.list()) {
    const name = `provider:${provider.kind}:${provider.id}`;
    try {
      const instance = runtime.providers.get(provider.kind, provider.id);
      if (!instance.healthCheck) {
        checks.push({ name, status: 'pass', detail: 'no health check' });
        continue;
      }
      const result = await instance.healthCheck();
      checks.push({ name, status: result.ok ? 'pass' : unhealthyStatus, detail: result.message });
    } catch (err) {
      checks.push({ name, status: unhealthyStatus, detail: (err as Error).message });
    }
  }
  return checks;
}

function summarize(checks: Check[]): DependencyHealth {
  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  return { status: hasFail ? 'down' : hasWarn ? 'degraded' : 'ok', checks };
}
