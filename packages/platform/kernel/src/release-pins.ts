import { migrationCatalog, type ModulePin, type ExtensionPin } from '@storeweave/db';
import { validateManifestShape, assertPlatformCompatibility, type ExtensionDefinition } from '@storeweave/extension-sdk';
import type { PlatformModule } from './module';

function sorted(values: readonly string[]): string[] { return [...values].sort(); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function projectModulePins(modules: readonly PlatformModule[]): ModulePin[] {
  const catalog = migrationCatalog(modules.flatMap(module => module.migrations ? [module.migrations] : []));
  return modules.map((module): ModulePin => ({
    kind: 'module', id: module.name, version: module.version,
    dataRelations: sorted(module.data?.owns ?? []),
    migrationOwner: module.migrations?.module ?? null,
    migrations: catalog.filter(migration => migration.owner === module.migrations?.module)
      .map(({ id, owner, phase, order, checksum }) => ({ id: id.slice(owner.length + 1), phase, order, checksum })),
    work: {
      jobTypes: sorted((module.jobs ?? []).map(job => job.type)),
      subscriberIds: module.subscribers?.length ? [module.name] : [],
      emittedEventNames: sorted((module.events ?? []).map(event => event.name)),
      subscribedEventNames: sorted((module.subscribers ?? []).map(subscriber => subscriber.eventName)),
    },
  })).sort((a, b) => compare(a.id, b.id));
}


export function projectExtensionPin(definition: ExtensionDefinition, platformVersion: string): ExtensionPin {
  const manifest = definition.manifest;
  validateManifestShape(manifest);
  assertPlatformCompatibility(manifest, platformVersion);
  const jobTypes = sorted(manifest.registeredJobs ?? []);
  if (jobTypes.some(type => !type.startsWith(`ext.${manifest.id}.`))) throw new Error(`Invalid extension job namespace: ${manifest.id}`);
  return { kind: 'extension', id: manifest.id, version: manifest.version, migrations: [], work: {
    jobTypes, subscriberIds: manifest.subscribedEvents.length ? [manifest.id] : [],
    emittedEventNames: [], subscribedEventNames: sorted(manifest.subscribedEvents),
  } };
}
