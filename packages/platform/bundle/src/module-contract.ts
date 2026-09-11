import { declaredInputKeys, inputObjectOf, noopLogger } from '@storeweave/contracts';
import type { BaseConfig } from '@storeweave/config';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { JobQueue } from '@storeweave/jobs';
import { EventBus } from '@storeweave/event-bus';
import { OutboxStore } from '@storeweave/outbox';
import {
  collectPages, composeRuntimeModules, parseScheduleSpec, scheduleOccurrencePayload,
} from '@storeweave/kernel';
import type { ReleaseDefinition } from './release';

export interface ModuleContractCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
}

const MIGRATION_ID = /^\d{4}_[a-z0-9_]+$/;
const CREATED_TABLE = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * Module Contract Test（ADR 0050）。模組的相依是否存在、版本是否相符、權限發給了誰，
 * 都是 release 的事實，所以檢查以 release 為範圍：不連資料庫、不執行 handler，
 * 只讀 release 的組裝宣告與該模組的宣告。
 */
export function runModuleContractChecks<C extends BaseConfig>(
  release: ReleaseDefinition<C>, moduleName: string,
): ModuleContractCheck[] {
  const checks: ModuleContractCheck[] = [];
  const push = (name: string, failed: readonly string[], message = failed.join(', ')) =>
    checks.push(failed.length === 0 ? { name, ok: true } : { name, ok: false, message });

  const config = release.config.schema.parse(release.manifestConfig);
  const releaseModules = release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
  const mod = releaseModules.find(candidate => candidate.name === moduleName);
  if (!mod) {
    push('module is part of the release', [`"${moduleName}" is not composed by release "${release.id}"`]);
    return checks;
  }
  push('module is part of the release', []);

  try {
    composeRuntimeModules({
      modules: releaseModules, roles: release.roles, platformVersion: release.baseVersion, logger: noopLogger,
      jobs: new JobQueue(), events: new EventBus(), outbox: new OutboxStore(),
      scheduler: () => { throw new Error('Module contract checks never run a scheduler'); },
    });
    push('module graph validates (dependencies, versions, names, permissions)', []);
  } catch (error) {
    push('module graph validates (dependencies, versions, names, permissions)', [error instanceof Error ? error.message : String(error)]);
  }

  const granted = new Set(Object.values(release.roles).flatMap(role => role.permissions));
  push('declared permissions are granted to a release role',
    (mod.permissions ?? []).map(permission => permission.key).filter(key => !granted.has(key)));

  const inputs = [...mod.commands ?? [], ...mod.queries ?? []];
  const notObjects = inputs.filter(({ descriptor }) => inputObjectOf(descriptor.input) === null).map(({ descriptor }) => descriptor.name);
  push('command / query inputs reject unknown keys', inputs
    .filter(({ descriptor }) => {
      const result = descriptor.input.safeParse({ __definitely_not_a_field__: 1 });
      return result.success || !result.error.issues.some(issue => issue.code === 'unrecognized_keys');
    })
    .map(({ descriptor }) => descriptor.name)
    .filter(name => !notObjects.includes(name)));
  push('command / query inputs are a plain object the HTTP bridge can pick keys from',
    inputs.filter(({ descriptor }) => declaredInputKeys(descriptor.input) === null).map(({ descriptor }) => descriptor.name));

  const owned = new Set(mod.data?.owns ?? []);
  const migrations = mod.migrations?.migrations ?? [];
  const created = migrations.flatMap(migration => [...migration.up.matchAll(CREATED_TABLE)].map(match => match[1]!.toLowerCase()));
  push('migrations only create tables listed in data.owns', [...new Set(created.filter(table => !owned.has(table)))]);
  const prefix = `${mod.name.replace(/-/g, '_')}_`;
  push(`owned tables carry the module prefix "${prefix}"`, [...owned].filter(table => !table.startsWith(prefix)));
  const ids = migrations.map(migration => migration.id);
  push('migration ids are ordered NNNN_name identifiers',
    ids.filter((id, index) => !MIGRATION_ID.test(id) || (index > 0 && id <= ids[index - 1]!)));

  const jobs = mod.jobs ?? [];
  push('jobs declare a payload contract', jobs.filter(job => !job.jobContractV1).map(job => job.type));
  push('scheduled jobs accept the payload their schedule produces', jobs.filter(job => {
    if (!job.schedule || !job.jobContractV1) return false;
    const payload = scheduleOccurrencePayload(parseScheduleSpec(job.type, job.schedule), new Date('2026-01-01T00:00:00.000Z'));
    const schema = job.jobContractV1.versions[job.jobContractV1.currentVersion];
    return !schema?.safeParse(payload).success;
  }).map(job => job.type));

  const requiredPages = collectPages([mod]).filter(page => page.required !== false).map(page => page.id);
  push('required pages have a renderer in every release theme', Object.entries(release.availableThemes).flatMap(([themeId, theme]) =>
    requiredPages.filter(id => !(id in theme.renderers)).map(id => `${themeId}: ${id}`)));

  return checks;
}

export function assertModuleContract(checks: readonly ModuleContractCheck[]): void {
  const failed = checks.filter(check => !check.ok);
  if (failed.length > 0) {
    throw new Error(`Module contract violations:\n${failed.map(check => ` - ${check.name}${check.message ? `: ${check.message}` : ''}`).join('\n')}`);
  }
}
