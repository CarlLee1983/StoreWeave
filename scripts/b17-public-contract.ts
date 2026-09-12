import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { catalogDigest } from '../packages/platform/db/src';
import { noopLogger } from '../packages/platform/contracts/src';
import { ProviderRegistry, createTestExtensionContext } from '../packages/platform/extension-sdk/src';
import { composeRuntimeModules, type PlatformModule } from '../packages/platform/kernel/src';
import { EventBus } from '../packages/platform/event-bus/src';
import { JobQueue } from '../packages/platform/jobs/src';
import { OutboxStore } from '../packages/platform/outbox/src';
import { release as commerceRelease } from '../packages/platform/bundle/src/releases/commerce';

const ROOT = resolve(__dirname, '..');
export const B00_CATALOG_PATH = resolve(ROOT, 'docs/base/b17/b00-catalog.json');
export const HTTP_ARTIFACT_PATH = resolve(ROOT, 'docs/base/b17/commerce-http-contract.v1.json');
export const DEFAULT_ARTIFACT_PATH = resolve(ROOT, 'docs/base/b17/commerce-public-contract.structural.v1.json');

type Category = 'commands' | 'queries' | 'events' | 'jobs';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CommercePublicContract {
  format: 'storeweave.commerce-public-contract.structural.v1';
  scope: 'structural';
  remaining: readonly ['semantic-cases'];
  release: { id: string; baseVersion: string };
  source: {
    catalog: string; catalogDigest: string;
    httpCatalog: string; httpCatalogSha256: string;
  };
  commands: readonly { name: string; version: number; permission: string; idempotency: string; input: Json; output: Json }[];
  queries: readonly { name: string; version: number; permission: string; input: Json; output: Json }[];
  events: readonly { name: string; version: number; payload: Json }[];
  jobs: readonly { type: string; currentVersion: number; versions: readonly { version: number; payload: Json }[]; upgraderFromVersions: readonly number[]; execution: Json; schedule: Json }[];
  extensions: readonly ExtensionContract[];
}

interface ExtensionContract {
  manifest: {
    id: string; name: string; version: string; platformVersion: string; permissions: readonly string[];
    declaredPermissions: readonly { key: string; description: string }[]; requiredSecretNames: readonly string[];
    configuration: Json; subscribedEvents: readonly string[]; registeredCommands: readonly string[];
    registeredQueries: readonly string[]; registeredJobs: readonly string[];
    registeredProviders: readonly { kind: string; id: string; isDefault?: boolean }[];
  };
  registration: {
    commands: readonly { name: string; version: number; permission: string; idempotency: string; input: Json; output: Json }[];
    queries: readonly { name: string; version: number; permission: string; input: Json; output: Json }[];
    events: readonly { name: string; maxAttempts?: number }[];
    jobs: readonly { type: string; currentVersion: number; versions: readonly { version: number; payload: Json }[]; upgraderFromVersions: readonly number[]; execution: Json; schedule: Json }[];
    providers: readonly { kind: string; id: string }[];
    mcpTools: readonly { name: string; description: string; target: { kind: string; name: string }; input: Json }[];
  };
}

function compareBy<T>(value: (entry: T) => string): (left: T, right: T) => number {
  return (left, right) => value(left) < value(right) ? -1 : value(left) > value(right) ? 1 : 0;
}

/** JSON-safe deep clone with lexicographically ordered object keys. */
export function canonicalJson(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Public contract contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Public contract contains a non-plain JSON value');
  }
  const result: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort(compareBy(key => key))) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    result[key] = canonicalJson(entry);
  }
  return result;
}

function schema(value: unknown): Json {
  return canonicalJson(zodToJsonSchema(value as never, { target: 'jsonSchema7', $refStrategy: 'none' }));
}

export function composedCommerceModules(): readonly PlatformModule[] {
  const config = commerceRelease.config.schema.parse(commerceRelease.manifestConfig);
  return composeRuntimeModules({
    modules: commerceRelease.createModules({ config, providers: new ProviderRegistry(noopLogger) }),
    roles: commerceRelease.roles,
    logger: noopLogger,
    platformVersion: commerceRelease.baseVersion,
    jobs: new JobQueue(),
    events: new EventBus(),
    outbox: new OutboxStore(),
    scheduler: () => { throw new Error('B17 public-contract projection has no scheduler'); },
  });
}

function extensionFixture(id: string): unknown {
  return id === 'ecpay' ? { returnUrl: 'https://catalog.invalid/return' } : {};
}

function requiredSecretPlaceholders(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map(name => [name,
    /HASH_(?:KEY|IV)$/.test(name) ? '0123456789abcdef' : 'catalog-placeholder',
  ]));
}

function names(entries: readonly { name: string }[]): string[] {
  return entries.map(entry => entry.name).sort(compareBy(entry => entry));
}

function types(entries: readonly { type: string }[]): string[] {
  return entries.map(entry => entry.type).sort(compareBy(entry => entry));
}

function providerIds(entries: readonly { kind: string; id: string }[]): string[] {
  return entries.map(entry => `${entry.kind}:${entry.id}`).sort(compareBy(entry => entry));
}

async function projectExtensions(): Promise<ExtensionContract[]> {
  const definitions = Object.values(commerceRelease.availableExtensions as Record<string, any>)
    .sort(compareBy(definition => definition.manifest.id));
  return Promise.all(definitions.map(async definition => {
    const manifest = definition.manifest;
    const config = manifest.configuration.parse(extensionFixture(manifest.id));
    const registration = await definition.setup(createTestExtensionContext({
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      platformVersion: commerceRelease.baseVersion,
      config,
      secrets: requiredSecretPlaceholders(manifest.requiredSecrets ?? []),
    }));
    const commands = (registration.commands ?? []).map((entry: any) => ({
      name: entry.descriptor.name, version: entry.descriptor.version, permission: entry.descriptor.permission,
      idempotency: entry.descriptor.idempotency, input: schema(entry.descriptor.input), output: schema(entry.descriptor.output),
    })).sort(compareBy((entry: { name: string }) => entry.name));
    const queries = (registration.queries ?? []).map((entry: any) => ({
      name: entry.descriptor.name, version: entry.descriptor.version, permission: entry.descriptor.permission,
      input: schema(entry.descriptor.input), output: schema(entry.descriptor.output),
    })).sort(compareBy((entry: { name: string }) => entry.name));
    const jobs = (registration.jobs ?? []).map((job: any) => {
      if (!job.jobContractV1) throw new Error(`Extension job ${job.type} has no payload contract`);
      const contract = job.jobContractV1;
      return {
        type: job.type, currentVersion: contract.currentVersion,
        versions: Object.keys(contract.versions).map(Number).sort((a, b) => a - b)
          .map(version => ({ version, payload: schema(contract.versions[version]) })),
        upgraderFromVersions: Object.keys(contract.upgrades ?? {}).map(Number).sort((a, b) => a - b),
        execution: canonicalJson(contract.execution ?? {}), schedule: canonicalJson(job.schedule ?? {}),
      };
    }).sort(compareBy((entry: { type: string }) => entry.type));
    const events = (registration.events ?? []).map((entry: any) => ({ name: entry.event, ...(entry.maxAttempts === undefined ? {} : { maxAttempts: entry.maxAttempts }) }))
      .sort(compareBy((entry: { name: string }) => entry.name));
    const providers = (registration.providers ?? []).map((entry: any) => ({ kind: entry.kind, id: entry.id }))
      .sort(compareBy((entry: { kind: string; id: string }) => `${entry.kind}:${entry.id}`));
    const mcpTools = (registration.mcpTools ?? []).map((entry: any) => ({
      name: entry.name, description: entry.description, target: { kind: entry.target.kind, name: entry.target.name }, input: schema(entry.input),
    })).sort(compareBy((entry: { name: string }) => entry.name));
    const declaredCommands = [...manifest.registeredCommands].sort(compareBy(entry => entry));
    const declaredQueries = [...manifest.registeredQueries].sort(compareBy(entry => entry));
    const declaredJobs = [...(manifest.registeredJobs ?? [])].sort(compareBy(entry => entry));
    const declaredEvents = [...manifest.subscribedEvents].sort(compareBy(entry => entry));
    const declaredProviders = [...manifest.registeredProviders].sort(compareBy(entry => `${entry.kind}:${entry.id}`));
    if (JSON.stringify(names(commands)) !== JSON.stringify(declaredCommands)
      || JSON.stringify(names(queries)) !== JSON.stringify(declaredQueries)
      || JSON.stringify(types(jobs)) !== JSON.stringify(declaredJobs)
      || JSON.stringify(names(events)) !== JSON.stringify(declaredEvents)
      || JSON.stringify(providerIds(providers)) !== JSON.stringify(providerIds(declaredProviders))) {
      throw new Error(`Extension ${manifest.id} registration does not exactly match its manifest`);
    }
    return {
      manifest: {
        id: manifest.id, name: manifest.name, version: manifest.version, platformVersion: manifest.platformVersion,
        permissions: [...manifest.permissions].sort(compareBy(entry => entry)),
        declaredPermissions: [...(manifest.declaredPermissions ?? [])].sort(compareBy(entry => entry.key)),
        requiredSecretNames: [...(manifest.requiredSecrets ?? [])].sort(compareBy(entry => entry)),
        configuration: schema(manifest.configuration), subscribedEvents: declaredEvents, registeredCommands: declaredCommands,
        registeredQueries: declaredQueries, registeredJobs: declaredJobs, registeredProviders: declaredProviders,
      },
      registration: { commands, queries, events, jobs, providers, mcpTools },
    };
  }));
}

export async function projectCommercePublicContract(): Promise<CommercePublicContract> {
  const modules = composedCommerceModules();
  const commands = modules.flatMap(module => (module.commands ?? []).map(({ descriptor }) => ({
    name: descriptor.name, version: descriptor.version, permission: descriptor.permission, idempotency: descriptor.idempotency,
    input: schema(descriptor.input), output: schema(descriptor.output),
  }))).sort(compareBy(entry => entry.name));
  const queries = modules.flatMap(module => (module.queries ?? []).map(({ descriptor }) => ({
    name: descriptor.name, version: descriptor.version, permission: descriptor.permission,
    input: schema(descriptor.input), output: schema(descriptor.output),
  }))).sort(compareBy(entry => entry.name));
  const events = modules.flatMap(module => (module.events ?? []).map(event => ({
    name: event.name, version: event.version, payload: schema(event.payload),
  }))).sort(compareBy(entry => entry.name));
  const jobs = modules.flatMap(module => (module.jobs ?? []).map(job => {
    if (!job.jobContractV1) throw new Error(`Core job ${job.type} has no payload contract`);
    const contract = job.jobContractV1;
    return {
      type: job.type,
      currentVersion: contract.currentVersion,
      versions: Object.keys(contract.versions).map(Number).sort((a, b) => a - b)
        .map(version => ({ version, payload: schema(contract.versions[version]!) })),
      upgraderFromVersions: Object.keys(contract.upgrades ?? {}).map(Number).sort((a, b) => a - b),
      execution: canonicalJson(contract.execution ?? {}),
      schedule: canonicalJson(job.schedule ?? {}),
    };
  })).sort(compareBy(entry => entry.type));
  const catalog = JSON.parse(readFileSync(B00_CATALOG_PATH, 'utf8')) as unknown;
  const httpCatalogSha256 = createHash('sha256').update(readFileSync(HTTP_ARTIFACT_PATH)).digest('hex');
  const extensions = await projectExtensions();
  return canonicalJson({
    format: 'storeweave.commerce-public-contract.structural.v1',
    scope: 'structural',
    remaining: ['semantic-cases'],
    release: { id: commerceRelease.id, baseVersion: commerceRelease.baseVersion },
    source: {
      catalog: 'docs/base/b17/b00-catalog.json', catalogDigest: catalogDigest(catalog),
      httpCatalog: 'docs/base/b17/commerce-http-contract.v1.json', httpCatalogSha256,
    },
    commands, queries, events, jobs, extensions,
  }) as unknown as CommercePublicContract;
}

export function categoryNames(contract: CommercePublicContract): Record<Category, string[]> {
  return {
    commands: contract.commands.map(entry => entry.name),
    queries: contract.queries.map(entry => entry.name),
    events: contract.events.map(entry => entry.name),
    jobs: contract.jobs.map(entry => entry.type),
  };
}

export async function serializeCommercePublicContract(contract?: CommercePublicContract): Promise<string> {
  return `${JSON.stringify(canonicalJson(contract ?? await projectCommercePublicContract()), null, 2)}\n`;
}

function usage(): never {
  throw new Error('Usage: tsx scripts/b17-public-contract.ts [--check | --output <new path>]');
}

export async function run(argv: readonly string[]): Promise<void> {
  const output = await serializeCommercePublicContract();
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--check')) {
    if (!existsSync(DEFAULT_ARTIFACT_PATH)) throw new Error(`Missing checked-in public contract: ${DEFAULT_ARTIFACT_PATH}`);
    if (readFileSync(DEFAULT_ARTIFACT_PATH, 'utf8') !== output) throw new Error('Checked-in public contract differs; generate a candidate with --output <new path> and review it.');
    return;
  }
  if (argv.length !== 2 || argv[0] !== '--output') usage();
  const target = resolve(argv[1]!);
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing public contract candidate: ${target}`);
  writeFileSync(target, output, { encoding: 'utf8', flag: 'wx' });
}

if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
