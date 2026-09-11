import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BASE_ROLES, type ReleaseRoleCatalog } from '@storeweave/authorization';
import { defineCommand, defineEvent, defineQuery } from '@storeweave/contracts';
import { sqlMigration } from '@storeweave/db';
import { definePage, type PlatformModule } from '@storeweave/kernel';
import { assertModuleContract, runModuleContractChecks, type ModuleContractCheck } from '@storeweave/bundle';
import { release as baseRelease } from '../src/releases/base';
import type { ReleaseDefinition } from '../src/release';
import type { BaseConfig } from '@storeweave/config';

const GRANTED: ReleaseRoleCatalog = {
  ...BASE_ROLES,
  member: { ...BASE_ROLES.member, permissions: [...BASE_ROLES.member.permissions, 'probe:use'] },
};

function probe(overrides: Partial<PlatformModule> = {}): PlatformModule {
  return {
    name: 'probe', version: '1.0.0', baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    data: { owns: ['probe_items'] },
    migrations: { module: 'probe', migrations: [
      sqlMigration('0001_init', 'expand', 'CREATE TABLE IF NOT EXISTS public.probe_items (id uuid PRIMARY KEY);'),
    ] },
    permissions: [{ key: 'probe:use', description: 'Use the probe', owner: 'probe' }],
    events: [defineEvent({ name: 'probe.item.created.v1', payload: z.object({ id: z.string() }) })],
    commands: [{
      descriptor: defineCommand({ name: 'probe.item.create', input: z.object({ title: z.string() }).strict(), output: z.unknown(), permission: 'probe:use' }),
      handler: async () => undefined,
    }],
    queries: [{
      descriptor: defineQuery({ name: 'probe.item.list', input: z.object({}).strict(), output: z.unknown(), permission: 'probe:use' }),
      handler: async () => undefined,
    }],
    jobs: [{
      type: 'probe.item.cleanup', handler: async () => undefined,
      schedule: { cron: '0 3 * * *', timezone: 'Asia/Taipei' },
      jobContractV1: { currentVersion: 1, versions: { 1: z.object({ scheduledFor: z.string().datetime() }).strict() } },
    }],
    ...overrides,
  };
}

function releaseWith(module: PlatformModule, roles: ReleaseRoleCatalog = GRANTED): ReleaseDefinition<BaseConfig> {
  return { ...baseRelease, id: 'contract-probe', roles, createModules: context => [...baseRelease.createModules(context), module] };
}

function failures(checks: readonly ModuleContractCheck[]): string[] {
  return checks.filter(check => !check.ok).map(check => `${check.name}: ${check.message ?? ''}`);
}

function failureOf(module: PlatformModule, roles?: ReleaseRoleCatalog): string {
  return failures(runModuleContractChecks(releaseWith(module, roles), 'probe')).join('\n');
}

describe('Module Contract Test', () => {
  it('passes a module that follows every contract', () => {
    expect(failures(runModuleContractChecks(releaseWith(probe()), 'probe'))).toEqual([]);
  });

  it('reports a module that is not part of the release', () => {
    expect(failures(runModuleContractChecks(baseRelease, 'probe'))).toEqual(['module is part of the release: "probe" is not composed by release "base"']);
  });

  it('reports missing dependencies and version mismatches through the module graph', () => {
    expect(failureOf(probe({ dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }, { name: 'reports', versionRange: '^1.0.0' }] } })))
      .toContain('module "probe" requires missing module "reports"');
    expect(failureOf(probe({ dependencies: { required: [{ name: 'platform-notifications', versionRange: '^9.0.0' }] } })))
      .toContain('requires platform-notifications@^9.0.0');
  });

  it('reports naming conflicts with modules already in the release', () => {
    const clash = probe({ queries: [{
      descriptor: defineQuery({ name: 'platform.site.getChrome', input: z.object({}).strict(), output: z.unknown(), permission: 'probe:use' }),
      handler: async () => undefined,
    }] });
    expect(failureOf(clash)).toContain('query "platform.site.getChrome" is declared by both');
  });

  it('reports permissions that are undeclared or granted to no role', () => {
    expect(failureOf(probe(), BASE_ROLES)).toContain('declared permissions are granted to a release role: probe:use');
    const undeclared = probe({ commands: [{
      descriptor: defineCommand({ name: 'probe.item.create', input: z.object({}).strict(), output: z.unknown(), permission: 'probe:missing' }),
      handler: async () => undefined,
    }] });
    expect(failureOf(undeclared)).toContain('probe:missing');
  });

  it('reports inputs that accept unknown keys or are not plain objects', () => {
    const lax = probe({ commands: [{
      descriptor: defineCommand({ name: 'probe.item.create', input: z.object({ title: z.string() }), output: z.unknown(), permission: 'probe:use' }),
      handler: async () => undefined,
    }], queries: [{
      descriptor: defineQuery({ name: 'probe.item.list', input: z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.string() }).strict()]), output: z.unknown(), permission: 'probe:use' }),
      handler: async () => undefined,
    }] });
    const report = failureOf(lax);
    expect(report).toContain('command / query inputs reject unknown keys: probe.item.create');
    expect(report).toContain('command / query inputs are a plain object the HTTP bridge can pick keys from: probe.item.list');
  });

  it('reports tables the module creates without owning them, or owns without its prefix', () => {
    const hidden = probe({ migrations: { module: 'probe', migrations: [
      sqlMigration('0001_init', 'expand', 'CREATE TABLE IF NOT EXISTS public.probe_items (id uuid PRIMARY KEY);\nCREATE TABLE probe_hidden (id uuid);'),
    ] } });
    expect(failureOf(hidden)).toContain('migrations only create tables listed in data.owns: probe_hidden');
    expect(failureOf(probe({ data: { owns: ['probe_items', 'items_archive'] } }))).toContain('owned tables carry the module prefix "probe_": items_archive');
  });

  it('reports migration ids that are not ordered four-digit ids', () => {
    const disordered = probe({ migrations: { module: 'probe', migrations: [
      sqlMigration('0002_later', 'expand', 'SELECT 1;'),
      sqlMigration('0001_init', 'expand', 'CREATE TABLE IF NOT EXISTS public.probe_items (id uuid PRIMARY KEY);'),
    ] } });
    expect(failureOf(disordered)).toContain('migration ids are ordered NNNN_name identifiers: 0001_init');
  });

  it('reports jobs without a payload contract and schedules their contract cannot read', () => {
    expect(failureOf(probe({ jobs: [{ type: 'probe.item.cleanup', handler: async () => undefined }] })))
      .toContain('jobs declare a payload contract: probe.item.cleanup');
    expect(failureOf(probe({ jobs: [{
      type: 'probe.item.cleanup', handler: async () => undefined, schedule: { everyMs: 60_000 },
      jobContractV1: { currentVersion: 1, versions: { 1: z.object({ scheduledFor: z.string().datetime() }).strict() } },
    }] }))).toContain('scheduled jobs accept the payload their schedule produces: probe.item.cleanup');
  });

  it('reports required pages that a release theme cannot render', () => {
    const pages = { view: definePage({
      id: 'probe.item.view', path: '/probe', method: 'get', audience: 'public', input: z.object({}),
      contract: { kind: 'storefront', request: 'none', input: { type: 'object', properties: {}, additionalProperties: false },
        responses: [{ kind: 'html', status: 200, contentType: 'text/html; charset=utf-8', body: 'theme' }] },
      resolve: async () => ({ kind: 'view' as const, view: {} }),
    }) };
    expect(failureOf(probe({ pages }))).toContain('required pages have a renderer in every release theme: base: probe.item.view');
  });

  it('assertModuleContract lists every failure', () => {
    expect(() => assertModuleContract(runModuleContractChecks(releaseWith(probe(), BASE_ROLES), 'probe')))
      .toThrow(/Module contract violations:\n - declared permissions are granted to a release role: probe:use/);
  });
});
