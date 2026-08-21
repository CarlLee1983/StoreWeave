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

export async function liveness(): Promise<{ status: 'ok'; uptimeSeconds: number }> {
  return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
}

/** Ready = 可以接受流量：資料庫連得上且沒有未套用的 migration。 */
export async function readiness(runtime: Runtime): Promise<DependencyHealth> {
  const checks: Check[] = [];
  const ping = await runtime.database.ping();
  checks.push({
    name: 'postgres',
    status: ping.ok ? 'pass' : 'fail',
    detail: ping.ok ? `${ping.latencyMs}ms` : ping.error,
  });

  if (ping.ok) {
    const status = await runtime.migrationStatus();
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
  checks.push({ name: 'postgres', status: ping.ok ? 'pass' : 'fail', detail: ping.ok ? `${ping.latencyMs}ms` : ping.error });
  if (!ping.ok) return summarize(checks);

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

  for (const provider of runtime.providers.list()) {
    const instance = runtime.providers.get(provider.kind, provider.id);
    if (!instance.healthCheck) {
      checks.push({ name: `provider:${provider.kind}:${provider.id}`, status: 'pass', detail: 'no health check' });
      continue;
    }
    try {
      const result = await instance.healthCheck();
      checks.push({
        name: `provider:${provider.kind}:${provider.id}`,
        status: result.ok ? 'pass' : 'warn',
        detail: result.message,
      });
    } catch (err) {
      checks.push({ name: `provider:${provider.kind}:${provider.id}`, status: 'warn', detail: (err as Error).message });
    }
  }

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
  }

  for (const dir of [runtime.config.paths.dataDir, runtime.config.paths.backupDir]) {
    checks.push(directoryCheck(dir));
  }

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
  for (const token of runtime.config.auth.tokens) requiredSecrets.add(token.secretRef);
  for (const name of [...requiredSecrets].sort()) {
    checks.push({
      name: `secret present: ${name}`,
      status: runtime.secrets.has(name) ? 'pass' : 'fail',
      detail: runtime.secrets.has(name) ? 'set' : 'missing',
    });
  }

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

function summarize(checks: Check[]): DependencyHealth {
  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  return { status: hasFail ? 'down' : hasWarn ? 'degraded' : 'ok', checks };
}
