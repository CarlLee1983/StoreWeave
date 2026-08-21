import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './paths';

export const SERVICES = ['commerce-api', 'commerce-worker'] as const;
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
    execFileSync('systemctl', ['cat', 'commerce-api.service'], { stdio: 'ignore' });
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
  return join(resolvePaths().runDir, `${name}.pid`);
}

function readPid(name: ServiceName): number | null {
  const file = pidFile(name);
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function entrypoint(name: ServiceName): string {
  const paths = resolvePaths();
  const base = existsSync(paths.currentLink)
    ? paths.currentLink
    : process.env.COMMERCE_APP_DIR ?? process.cwd();
  return join(base, 'app', name === 'commerce-api' ? 'api.js' : 'worker.js');
}

export function startServices(): ServiceStatus[] {
  if (serviceManager() === 'systemd') {
    systemctl(['start', ...SERVICES.map((s) => `${s}.service`)]);
    return statusServices();
  }
  const paths = resolvePaths();
  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  for (const name of SERVICES) {
    if (readPid(name)) continue;
    const script = entrypoint(name);
    if (!existsSync(script)) throw new Error(`Missing application entrypoint: ${script}`);
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COMMERCE_CONFIG: paths.configFile },
    });
    child.unref();
    writeFileSync(pidFile(name), String(child.pid), 'utf8');
  }
  return statusServices();
}

export function stopServices(): ServiceStatus[] {
  if (serviceManager() === 'systemd') {
    systemctl(['stop', ...SERVICES.map((s) => `${s}.service`)]);
    return statusServices();
  }
  for (const name of SERVICES) {
    const pid = readPid(name);
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* 已結束 */ }
    }
    const file = pidFile(name);
    if (existsSync(file)) unlinkSync(file);
  }
  return statusServices();
}

export function statusServices(): ServiceStatus[] {
  const manager = serviceManager();
  return SERVICES.map((name): ServiceStatus => {
    if (manager === 'systemd') {
      try {
        const detail = systemctl(['is-active', `${name}.service`]);
        return { name, running: detail === 'active', detail, manager };
      } catch (err) {
        const detail = (err as { stdout?: string }).stdout?.trim() || 'inactive';
        return { name, running: false, detail, manager };
      }
    }
    const pid = readPid(name);
    return { name, running: Boolean(pid), detail: pid ? `pid ${pid}` : 'stopped', manager };
  });
}
