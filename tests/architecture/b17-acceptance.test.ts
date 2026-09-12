import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReleaseManifest } from '../../packages/platform/bundle/src/release-manifest';
import { assertThemeCoversPages, composeRuntimeModules } from '@storeweave/kernel';
import { noopLogger } from '@storeweave/contracts';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { EventBus } from '@storeweave/event-bus';
import { JobQueue } from '@storeweave/jobs';
import { OutboxStore } from '@storeweave/outbox';
import { baseTheme } from '@storeweave/theme-base';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { release as commerceRelease } from '../../packages/platform/bundle/src/releases/commerce';
import { release as fileRequestsRelease } from '../../packages/platform/bundle/src/releases/file-requests';
import { ROOT } from './source-graph';

const legacyBaselinePath = join(ROOT, 'packages/platform/bundle/src/legacy/commerce-pre-b02.json');
const legacyBaseline = JSON.parse(readFileSync(legacyBaselinePath, 'utf8')) as unknown;
const b00Catalog = JSON.parse(readFileSync(join(ROOT, 'docs/base/b17/b00-catalog.json'), 'utf8')) as {
  baseline: Record<'commands' | 'queries' | 'events' | 'jobs', string[]>;
  current: Record<'commands' | 'queries' | 'events' | 'jobs', string[]>;
  legacyOnly: Record<'commands' | 'queries' | 'events' | 'jobs', string[]>;
};
// The B00 document's command headline says 77, but expanding its bounded
// families yields 76. B10 subsequently added setArticleMedia, and later base
// capabilities added platform descriptors/jobs; the current composed registry
// is captured separately. B07 moved the lifecycle delivery worker to the base
// notification capability, leaving that job in the retained legacy baseline.
const B00_COUNTS = { commands: 76, queries: 57, events: 19, jobs: 14 } as const;
const CURRENT_COUNTS = { commands: 89, queries: 66, events: 19, jobs: 18 } as const;
const LEGACY_ONLY_IDENTIFIERS: Record<'commands' | 'queries' | 'events' | 'jobs', ReadonlySet<string>> = {
  commands: new Set(), queries: new Set(), events: new Set(), jobs: new Set(['commerce.notification.deliver-lifecycle']),
};

function catalogIdentifier(value: string): boolean {
  return /^(?:platform|commerce|ext)\.[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(value);
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}

function registeredCatalogIdentifiers(): Record<'commands' | 'queries' | 'events' | 'jobs', Set<string>> {
  const config = commerceRelease.config.schema.parse(commerceRelease.manifestConfig);
  const modules = composeRuntimeModules({
    modules: commerceRelease.createModules({ config, providers: new ProviderRegistry(noopLogger) }),
    roles: commerceRelease.roles, logger: noopLogger, platformVersion: commerceRelease.baseVersion,
    jobs: new JobQueue(), events: new EventBus(), outbox: new OutboxStore(),
    scheduler: () => { throw new Error('B17 catalog projection has no scheduler'); },
  });
  const identifiers = { commands: new Set<string>(), queries: new Set<string>(), events: new Set<string>(), jobs: new Set<string>() };
  for (const module of modules) {
    for (const command of module.commands ?? []) identifiers.commands.add(command.descriptor.name);
    for (const query of module.queries ?? []) identifiers.queries.add(query.descriptor.name);
    for (const event of module.events ?? []) identifiers.events.add(event.name);
    for (const job of module.jobs ?? []) identifiers.jobs.add(job.type);
    for (const subscriber of module.subscribers ?? []) identifiers.events.add(subscriber.eventName);
  }
  for (const extension of Object.values(commerceRelease.availableExtensions)) {
    for (const command of extension.manifest.registeredCommands) identifiers.commands.add(command);
    for (const query of extension.manifest.registeredQueries) identifiers.queries.add(query);
    for (const job of extension.manifest.registeredJobs ?? []) identifiers.jobs.add(job);
    for (const event of extension.manifest.subscribedEvents) identifiers.events.add(event);
  }
  return identifiers;
}

describe('B17 release acceptance contracts', () => {
  it('keeps one base version and two selectable themes for every website assembly', () => {
    expect(baseRelease.baseVersion).toBe(commerceRelease.baseVersion);
    for (const release of [baseRelease, commerceRelease, fileRequestsRelease]) {
      const themes = Object.values(release.availableThemes);
      expect(themes.length, release.id).toBeGreaterThanOrEqual(2);
      expect(new Set(themes.map(theme => theme.id)).size, release.id).toBe(themes.length);
      expect(themes.map(theme => theme.id), release.id).toEqual(expect.arrayContaining(['editorial']));
      for (const theme of themes) {
        expect(theme.renderers['platform.error'], `${release.id}/${theme.id}`).toBeTypeOf('function');
        expect(theme.optionsSchema.safeParse({}).success, `${release.id}/${theme.id}`).toBe(true);
      }
    }
  });

  it('validates every selectable theme against its release page graph', () => {
    const assertReleaseThemes = <C extends Parameters<typeof baseRelease.createModules>[0]['config']>(
      release: typeof baseRelease | typeof commerceRelease | typeof fileRequestsRelease,
    ) => {
      const config = release.config.schema.parse(release.manifestConfig) as C;
      // The release union has contravariant config types (Base vs Commerce); the
      // parsed manifest is the exact config for this concrete release at runtime.
      const modules = release.createModules({ config: config as never, providers: new ProviderRegistry(noopLogger) });
      for (const theme of Object.values(release.availableThemes)) {
        expect(() => assertThemeCoversPages(modules, theme), `${release.id}/${theme.id}`).not.toThrow();
      }
    };
    assertReleaseThemes(baseRelease);
    assertReleaseThemes(commerceRelease);
    assertReleaseThemes(fileRequestsRelease);
  });

  it('keeps commerce out of the base module graph and artifact source graph', () => {
    const manifest = buildReleaseManifest(baseRelease);
    expect(manifest.modules.map(module => module.id)).not.toEqual(expect.arrayContaining([
      'catalog', 'inventory', 'cart', 'customer', 'order', 'promotion', 'coupon', 'loyalty', 'shipping', 'invoice', 'refund', 'rma',
    ]));
    expect(manifest.availableExtensions).toEqual([]);
    // Keep this source check scoped to the actual Base release boundary; the
    // Commerce release and its tests are allowed to import the default theme.
    const baseSource = readFileSync(join(ROOT, 'packages/platform/bundle/src/releases/base.ts'), 'utf8');
    expect(baseSource).not.toContain('commerce.ts');
  });

  it('rejects a theme missing a required page before runtime startup', () => {
    const config = baseRelease.config.schema.parse(baseRelease.manifestConfig);
    const modules = baseRelease.createModules({ config, providers: new ProviderRegistry(noopLogger) });
    const { 'platform.site.home': _removed, ...renderers } = baseTheme.renderers;
    const incomplete = { ...baseTheme, id: 'incomplete', renderers: { ...renderers } };
    expect(() => assertThemeCoversPages(modules, incomplete)).toThrow('platform.site.home');
  });

  it('keeps every B00 identifier present until a retirement decision exists', () => {
    for (const category of Object.keys(B00_COUNTS) as (keyof typeof B00_COUNTS)[]) {
      const identifiers = b00Catalog.baseline[category];
      expect(identifiers.length, category).toBe(B00_COUNTS[category]);
      expect(new Set(identifiers).size, category).toBe(identifiers.length);
      expect(identifiers.every(catalogIdentifier), category).toBe(true);
      const current = b00Catalog.current[category];
      expect(current.length, `current ${category}`).toBe(CURRENT_COUNTS[category]);
      expect(new Set(current).size, `current ${category}`).toBe(current.length);
      expect(current.every(catalogIdentifier), `current ${category}`).toBe(true);
      expect(b00Catalog.legacyOnly[category], `legacy ${category}`).toEqual([...LEGACY_ONLY_IDENTIFIERS[category]]);
    }
    const registered = registeredCatalogIdentifiers();
    const legacy = new Set(stringValues(legacyBaseline).filter(catalogIdentifier));
    for (const category of Object.keys(B00_COUNTS) as (keyof typeof B00_COUNTS)[]) {
      const missing = b00Catalog.baseline[category].filter(identifier =>
        !registered[category].has(identifier) && !LEGACY_ONLY_IDENTIFIERS[category].has(identifier));
      expect(missing, category).toEqual([]);
      for (const identifier of LEGACY_ONLY_IDENTIFIERS[category]) expect(legacy.has(identifier), identifier).toBe(true);
      expect(new Set(b00Catalog.current[category]), `current registry ${category}`).toEqual(registered[category]);
    }
  });
});
