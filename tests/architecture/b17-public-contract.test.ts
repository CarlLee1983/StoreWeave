import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { catalogDigest } from '@storeweave/db';
import { release as commerceRelease } from '../../packages/platform/bundle/src/releases/commerce';
import {
  B00_CATALOG_PATH, DEFAULT_ARTIFACT_PATH, HTTP_ARTIFACT_PATH, categoryNames, projectCommercePublicContract, run, serializeCommercePublicContract,
  type CommercePublicContract,
} from '../../scripts/b17-public-contract';

type Category = 'commands' | 'queries' | 'events' | 'jobs';
const categories: readonly Category[] = ['commands', 'queries', 'events', 'jobs'];
const artifact = JSON.parse(readFileSync(DEFAULT_ARTIFACT_PATH, 'utf8')) as CommercePublicContract;
const b00Catalog = JSON.parse(readFileSync(B00_CATALOG_PATH, 'utf8')) as Record<'baseline' | 'current' | 'legacyOnly', Record<Category, string[]>>;

function catalogNames(section: 'baseline' | 'current', category: Category, extension: boolean): string[] {
  const legacy = new Set(b00Catalog.legacyOnly[category]);
  return b00Catalog[section][category].filter(name => name.startsWith('ext.') === extension && !legacy.has(name)).sort();
}

describe('B17 Commerce public-contract structural catalog', () => {
  it('checks the checked-in golden artifact without rewriting it', async () => {
    await expect(run(['--check'])).resolves.toBeUndefined();
    expect(readFileSync(DEFAULT_ARTIFACT_PATH, 'utf8')).toBe(await serializeCommercePublicContract());
  });

  it('has an explicit bounded scope and catalog provenance', () => {
    expect(artifact.format).toBe('storeweave.commerce-public-contract.structural.v1');
    expect(artifact.scope).toBe('structural');
    expect(artifact.remaining).toEqual(['semantic-cases']);
    expect(artifact.source).toEqual({
      catalog: 'docs/base/b17/b00-catalog.json', catalogDigest: catalogDigest(b00Catalog),
      httpCatalog: 'docs/base/b17/commerce-http-contract.v1.json',
      httpCatalogSha256: createHash('sha256').update(readFileSync(HTTP_ARTIFACT_PATH)).digest('hex'),
    });
  });

  it('exactly matches all composed core runtime names in every category', async () => {
    expect(categoryNames(artifact)).toEqual(categoryNames(await projectCommercePublicContract()));
    for (const category of categories) {
      expect(categoryNames(artifact)[category]).toEqual([...categoryNames(artifact)[category]].sort());
      expect(new Set(categoryNames(artifact)[category]).size).toBe(categoryNames(artifact)[category].length);
      expect(categoryNames(artifact)[category].some(name => name.startsWith('ext.'))).toBe(false);
    }
    expect(Object.fromEntries(categories.map(category => [category, categoryNames(artifact)[category].length])))
      .toEqual({ commands: 87, queries: 62, events: 19, jobs: 14 });
  });

  it('maps every non-extension, non-legacy B00 baseline and current identifier', () => {
    const names = categoryNames(artifact);
    for (const category of categories) {
      for (const section of ['baseline', 'current'] as const) {
        expect(names[category], `${section}/${category}`).toEqual(expect.arrayContaining(catalogNames(section, category, false)));
      }
    }
  });

  it('captures core recurring declarations alongside their versioned payload contracts', () => {
    expect(artifact.jobs.find(job => job.type === 'platform.media.cleanup-orphans')?.schedule)
      .toEqual({ everyMs: 86_400_000, overlap: 'skip' });
    expect(artifact.jobs.filter(job => Object.keys(job.schedule as object).length > 0).length).toBeGreaterThan(0);
  });

  it('captures every available extension and maps every B00 extension identifier', () => {
    expect(artifact.extensions.map(extension => extension.manifest.id))
      .toEqual(Object.values(commerceRelease.availableExtensions).map(extension => extension.manifest.id).sort());
    const actual = {
      commands: artifact.extensions.flatMap(extension => extension.registration.commands.map(entry => entry.name)),
      queries: artifact.extensions.flatMap(extension => extension.registration.queries.map(entry => entry.name)),
      events: artifact.extensions.flatMap(extension => extension.registration.events.map(entry => entry.name)),
      jobs: artifact.extensions.flatMap(extension => extension.registration.jobs.map(entry => entry.type)),
    };
    for (const extension of artifact.extensions) {
      expect(extension.manifest.registeredCommands).toEqual(extension.registration.commands.map(entry => entry.name));
      expect(extension.manifest.registeredQueries).toEqual(extension.registration.queries.map(entry => entry.name));
      expect(extension.manifest.registeredJobs).toEqual(extension.registration.jobs.map(entry => entry.type));
      expect(extension.manifest.subscribedEvents).toEqual(extension.registration.events.map(entry => entry.name));
      expect(extension.manifest.registeredProviders.map(provider => `${provider.kind}:${provider.id}`))
        .toEqual(extension.registration.providers.map(provider => `${provider.kind}:${provider.id}`));
    }
    for (const category of categories) {
      for (const section of ['baseline', 'current'] as const) {
        expect(actual[category], `${section}/${category}`).toEqual(expect.arrayContaining(catalogNames(section, category, true)));
      }
    }
  });
});
