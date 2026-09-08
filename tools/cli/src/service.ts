import { release } from '@storeweave/selected-release';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolvePaths } from './paths';

const servicePrefix = release.id === 'commerce' ? 'commerce' : 'storeweave';
export const SERVICES = [`${servicePrefix}-api`, `${servicePrefix}-worker`] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface ServiceStatus {
  name: ServiceName;
  running: boolean;
  detail: string;
  manager: 'systemd' | 'pidfile';
}

function hasSystemdUnits(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemctl', ['cat', `${SERVICES[0]}.service`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function systemctl(args: string[]): string {
  return execFileSync('systemctl', args, { encoding: 'utf8' }).trim();
}

/**
 * 有安裝 systemd unit 就用 systemd；否則退回 pid file 模式，
 * 讓開發機與尚未安裝 unit 的環境也能用同一組指令。
 */
export function serviceManager(): 'systemd' | 'pidfile' {
  return hasSystemdUnits() ? 'systemd' : 'pidfile';
}

function pidFile(name: ServiceName): string {
  return join(resolvePaths(release.id).runDir, `${name}.pid`);
}

function readPid(name: ServiceName): number | null {
  const file = pidFile(name);
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  const pid = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid)) throw new Error(`Invalid PID file: ${file}`);
  return isRunning(pid) ? pid : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function entrypoint(name: ServiceName): string {
  const paths = resolvePaths(release.id);
  const base = existsSync(paths.currentLink)
    ? paths.currentLink
    : process.env.STOREWEAVE_APP_DIR ?? (release.id === 'commerce' ? process.env.COMMERCE_APP_DIR : undefined) ?? process.cwd();
  return join(base, 'app', name === SERVICES[0] ? 'api.js' : 'worker.js');
}

export async function startServices(): Promise<ServiceStatus[]> {
  if (serviceManager() === 'systemd') {
    const before = statusServices();
    if (before.some(service => service.manager !== 'systemd' || !service.detail || service.detail === 'unknown')) {
      throw new Error('Cannot determine systemd service state; refusing to start');
    }
    const starting = before.filter(service => ['inactive', 'failed'].includes(service.detail))
      .map(service => `${service.name}.service`);
    try {
      systemctl(['start', ...SERVICES.map(name => `${name}.service`)]);
      return statusServices();
    } catch (error) {
      try { if (starting.length) systemctl(['stop', ...starting]); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Service startup failed and cleanup could not stop newly started services'); }
      throw error;
    }
  }
  const started: { name: ServiceName; pid: number }[] = [];
  try {
    const paths = resolvePaths(release.id);
    mkdirSync(paths.runDir, { recursive: true });
    mkdirSync(paths.logDir, { recursive: true });
    for (const name of SERVICES) {
      if (readPid(name)) continue;
      const script = entrypoint(name);
      if (!existsSync(script)) throw new Error(`Missing application entrypoint: ${script}`);
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, STOREWEAVE_CONFIG: paths.configFile },
      });
      await once(child, 'spawn');
      started.push({ name, pid: child.pid! });
      child.unref();
      writeFileSync(pidFile(name), String(child.pid), 'utf8');
    }
    return statusServices();
  } catch (error) {
    try { await stopPidServices(started, 30_000); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Service startup failed and cleanup could not stop newly started services'); }
    throw error;
  }
}

export async function stopServices(timeoutMs = 30_000): Promise<ServiceStatus[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid service stop timeout');
  if (serviceManager() === 'systemd') {
    systemctl(['stop', ...SERVICES.map((s) => `${s}.service`)]);
    return statusServices();
  }
  const stopping = SERVICES.map(name => ({ name, pid: readPid(name) }));
  await stopPidServices(stopping, timeoutMs);
  const statuses = statusServices();
  if (statuses.some(service => service.running)) throw new Error('A service restarted while stopping; refusing to proceed');
  return statuses;
}

async function stopPidServices(stopping: readonly { name: ServiceName; pid: number | null }[], timeoutMs: number): Promise<void> {
  for (const { pid } of stopping) {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  const deadline = performance.now() + timeoutMs;
  while (stopping.some(({ pid }) => pid !== null && isRunning(pid))) {
    if (performance.now() >= deadline) throw new Error('Service stop timed out; PID files retained and services may still be running');
    await delay(Math.min(50, Math.max(1, deadline - performance.now())));
  }
  for (const { name, pid } of stopping) {
    const file = pidFile(name);
    if (existsSync(file) && (pid === null ? readPid(name) === null : readFileSync(file, 'utf8').trim() === String(pid))) unlinkSync(file);
  }
}

export function statusServices(): ServiceStatus[] {
  const manager = serviceManager();
  return SERVICES.map((name): ServiceStatus => {
    if (manager === 'systemd') {
      try {
        const detail = systemctl(['is-active', `${name}.service`]);
        return { name, running: detail === 'active', detail, manager };
      } catch (err) {
        const result = err as { stdout?: string; status?: number };
        const state = result.stdout?.trim();
        const detail = result.status === 3 && (state === 'inactive' || state === 'failed') ? state : 'unknown';
        return { name, running: false, detail, manager };
      }
    }
    const pid = readPid(name);
    return { name, running: Boolean(pid), detail: pid ? `pid ${pid}` : 'stopped', manager };
  });
}
