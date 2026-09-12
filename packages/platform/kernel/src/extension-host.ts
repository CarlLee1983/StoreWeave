import { closeInReverse } from './lifecycle';
import {
  PlatformError, SYSTEM_ACTOR, extensionActor,
  type Actor, type Logger,
} from '@storeweave/contracts';
import type { Database } from '@storeweave/db';
import type { CommandBus } from '@storeweave/command-bus';
import type { QueryBus } from '@storeweave/query-bus';
import type { EventBus } from '@storeweave/event-bus';
import type { JobQueue } from '@storeweave/jobs';
import type { AuthorizationService } from '@storeweave/authorization';
import type { SecretProvider } from '@storeweave/config';
import { createHttpClient } from '@storeweave/http-client';
import {
  assertPlatformCompatibility,
  ProviderRegistry,
  type AnyProvider,
  type ExtensionContext,
  type ExtensionDefinition,
  type ExtensionManifest,
  type ExtensionRegistration,
  type ProviderKind,
} from '@storeweave/extension-sdk';
import { DbExtensionStore } from './extension-store';
import type { JobRegistry } from './job-registry';
import type { McpToolRegistry } from './mcp-registry';
import type { MailService } from '@storeweave/mail';
import { parseScheduleSpec, scheduleOccurrencePayload, type RecurringScheduler } from './recurring';

export interface MountedExtension {
  id: string;
  name: string;
  version: string;
  platformVersion: string;
  enabled: boolean;
  permissions: readonly string[];
  subscribedEvents: readonly string[];
  commands: readonly string[];
  queries: readonly string[];
  jobs: readonly string[];
  providers: readonly string[];
  mcpTools: readonly string[];
  context: ExtensionContext<any>;
  definition: ExtensionDefinition<any>;
  registration: ExtensionRegistration;
}

export interface ExtensionHostDeps {
  database: Database;
  commandBus: CommandBus;
  queryBus: QueryBus;
  eventBus: EventBus;
  jobs: JobQueue;
  jobRegistry: JobRegistry;
  recurring: Pick<RecurringScheduler, 'register' | 'specFor'>;
  providers: ProviderRegistry;
  mcpTools: McpToolRegistry;
  authorization: AuthorizationService;
  secrets: SecretProvider;
  logger: Logger;
  platformVersion: string;
  mail: MailService;
}

/**
 * 掛載 Extension。這是唯一把 Extension 接進平台的地方。
 * 所有能力都經由 ExtensionContext 授予，Extension 沒有其他門路。
 */
export class ExtensionHost {
  private readonly mounted: MountedExtension[] = [];
  private readonly pending = new Set<Promise<MountedExtension>>();
  private closing?: Promise<void>;

  constructor(private readonly deps: ExtensionHostDeps) {}

  list(): readonly MountedExtension[] {
    return this.mounted;
  }

  find(id: string): MountedExtension | undefined {
    return this.mounted.find((e) => e.id === id);
  }

  mount(definition: ExtensionDefinition<any>, rawConfig: unknown): Promise<MountedExtension> {
    if (this.closing) return Promise.reject(new Error('Extension host is closing'));
    const pending = this.mountDefinition(definition, rawConfig);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await closeInReverse(this.mounted.map(extension => () => extension.registration.close?.()));
    })();
  }

  private async mountDefinition(definition: ExtensionDefinition<any>, rawConfig: unknown): Promise<MountedExtension> {
    const manifest = definition.manifest;
    assertPlatformCompatibility(manifest, this.deps.platformVersion);

    if (this.mounted.some((e) => e.id === manifest.id)) {
      throw PlatformError.conflict(`Extension "${manifest.id}" is already mounted`);
    }

    const declaredPermissionKeys = new Set((manifest.declaredPermissions ?? []).map(permission => permission.key));
    for (const p of manifest.declaredPermissions ?? []) {
      this.deps.authorization.permissions.assertAvailable({ key: p.key, description: p.description, owner: manifest.id });
    }
    for (const permission of manifest.permissions) {
      if (!declaredPermissionKeys.has(permission)) {
        this.deps.authorization.permissions.assertKnown(permission, `extension ${manifest.id}`);
      }
    }
    for (const secretName of manifest.requiredSecrets ?? []) {
      if (!this.deps.secrets.has(secretName)) {
        throw PlatformError.validation(`Extension "${manifest.id}" requires secret "${secretName}" which is not set`);
      }
    }

    const parsedConfig = manifest.configuration.safeParse(rawConfig ?? {});
    if (!parsedConfig.success) {
      throw PlatformError.validation(
        `Invalid configuration for extension "${manifest.id}"`,
        parsedConfig.error.issues,
      );
    }

    // The manifest is not a claim to an already-owned carrier id. Reject known
    // collisions before setup(), so a misconfigured extension never starts
    // initialization.
    const declaredProviderKeys = manifest.registeredProviders.map((provider) => `${provider.kind}:${provider.id}`);
    if (new Set(declaredProviderKeys).size !== declaredProviderKeys.length) {
      throw PlatformError.validation(`Extension "${manifest.id}" declares the same provider more than once`);
    }
    for (const provider of manifest.registeredProviders) {
      if (this.deps.providers.has(provider.kind, provider.id)) {
        throw PlatformError.conflict(`Provider "${provider.kind}:${provider.id}" already registered`);
      }
    }

    // setup() has configuration/secrets/store access, but not carrier-bound
    // data access. A manifest is only a declaration; bind provider ownership
    // after its concrete providers have passed validation and been registered.
    const setupActor: Actor = extensionActor(manifest.id, manifest.permissions);
    const setupContext = this.createContext(definition, parsedConfig.data, setupActor);
    const registration = await definition.setup(setupContext);

    try {
      this.assertMatchesManifest(manifest.id, manifest, registration);
      this.preflightRegistration(manifest, registration);

      for (const permission of manifest.declaredPermissions ?? []) {
        this.deps.authorization.permissions.register({ ...permission, owner: manifest.id });
      }

      for (const provider of registration.providers ?? []) {
        // The manifest is the declaration checked before setup. Preserve its default
        // designation when mounting so replacing a payment extension is configuration,
        // not a change to order or storefront code.
        const declared = manifest.registeredProviders.find(
          (candidate) => candidate.kind === provider.kind && candidate.id === provider.id,
        );
        this.deps.providers.register({ provider, owner: manifest.id, isDefault: declared?.isDefault });
      }

      const actor: Actor = extensionActor(
        manifest.id,
        manifest.permissions,
        manifest.registeredProviders.map((provider) => `${provider.kind}:${provider.id}`),
      );
      const context = this.createContext(definition, parsedConfig.data, actor);

      for (const permission of registration.permissions ?? []) {
        this.deps.authorization.permissions.register({ ...permission, owner: manifest.id });
      }
      for (const policy of registration.policies ?? []) {
        this.deps.authorization.policies.register({ ...policy, owner: manifest.id });
      }
      // 只把 ExtensionContext 交給 handler —— tx / db 不會流進 Extension
      for (const cmd of registration.commands ?? []) {
        this.deps.commandBus.register(
          cmd.descriptor,
          async (input, commandCtx) =>
            cmd.handler(input, { ...context, actor: commandCtx.actor, correlationId: commandCtx.correlationId }),
          manifest.id,
        );
      }
      for (const q of registration.queries ?? []) {
        this.deps.queryBus.register(
          q.descriptor,
          async (input, queryCtx) =>
            q.handler(input, { ...context, actor: queryCtx.actor, correlationId: queryCtx.correlationId }),
          manifest.id,
        );
      }
      for (const tool of registration.mcpTools ?? []) {
        this.deps.mcpTools.register(tool, manifest.id);
      }
      for (const job of registration.jobs ?? []) {
        this.deps.jobRegistry.register(job.type, async (payload, jobCtx) => {
          await job.handler(payload, {
            ...context,
            attempt: jobCtx.attempt,
            jobId: jobCtx.jobId,
            occurrenceId: jobCtx.occurrenceId,
            idempotencyKey: jobCtx.idempotencyKey,
            signal: jobCtx.signal,
          });
        }, manifest.id, job.jobContractV1);
      }
      for (const sub of registration.events ?? []) {
        this.deps.eventBus.subscribe({
          subscriberId: manifest.id,
          eventName: sub.event,
          maxAttempts: sub.maxAttempts,
        handler: async (event, eventCtx) => {
            await sub.handler(event, { ...context, eventId: eventCtx.eventId, idempotencyKey: eventCtx.idempotencyKey });
          },
        });
      }
      for (const job of registration.jobs ?? []) {
        if (job.schedule) this.deps.recurring.register(job.type, job.schedule);
      }

      const mounted: MountedExtension = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        platformVersion: manifest.platformVersion,
        enabled: true,
        permissions: manifest.permissions,
        subscribedEvents: manifest.subscribedEvents,
        commands: (registration.commands ?? []).map((c) => c.descriptor.name),
        queries: (registration.queries ?? []).map((q) => q.descriptor.name),
        jobs: (registration.jobs ?? []).map(job => job.type),
        providers: (registration.providers ?? []).map((p) => `${p.kind}:${p.id}`),
        mcpTools: (registration.mcpTools ?? []).map((t) => t.name),
        context,
        definition,
        registration,
      };
      this.deps.logger.info({ extension: manifest.id, version: manifest.version }, 'extension mounted');
      this.mounted.push(mounted);
      return mounted;
    } catch (error) {
      try { await registration.close?.(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Extension mount and cleanup failed'); }
      throw error;
    }
  }

  private assertMatchesManifest(id: string, manifest: ExtensionManifest<any>, registration: ExtensionRegistration): void {
    const compare = (label: string, declared: readonly string[], actual: readonly string[]) => {
      const d = [...declared].sort().join(',');
      const a = [...actual].sort().join(',');
      if (d !== a) {
        throw PlatformError.validation(
          `Extension "${id}" ${label} mismatch: manifest declares [${d}] but setup() registered [${a}]`,
        );
      }
    };
    compare('commands', manifest.registeredCommands, (registration.commands ?? []).map((c) => c.descriptor.name));
    compare('queries', manifest.registeredQueries, (registration.queries ?? []).map((q) => q.descriptor.name));
    compare('jobs', manifest.registeredJobs ?? [], (registration.jobs ?? []).map(job => job.type));
    compare('subscribed events', manifest.subscribedEvents, (registration.events ?? []).map((e) => e.event));
    compare(
      'providers',
      manifest.registeredProviders.map((p) => `${p.kind}:${p.id}`),
      (registration.providers ?? []).map((p) => `${p.kind}:${p.id}`),
    );
    for (const cmd of registration.commands ?? []) {
      if (!cmd.descriptor.name.startsWith(`ext.${id}.`)) {
        throw PlatformError.validation(`Extension "${id}" may only register commands under "ext.${id}."`);
      }
    }
    for (const q of registration.queries ?? []) {
      if (!q.descriptor.name.startsWith(`ext.${id}.`)) {
        throw PlatformError.validation(`Extension "${id}" may only register queries under "ext.${id}."`);
      }
    }
    for (const job of registration.jobs ?? []) {
      if (!job.type.startsWith(`ext.${id}.`)) {
        throw PlatformError.validation(`Extension "${id}" may only register jobs under "ext.${id}."`);
      }
    }
  }

  /**
   * All deterministic registration failures are checked before the first shared
   * registry is mutated. Runtime activation is synchronous after this point, so
   * a rejected extension cannot leave a partially published surface behind.
   */
  private preflightRegistration(manifest: ExtensionManifest<any>, registration: ExtensionRegistration): void {
    const id = manifest.id;
    const permissions = [
      ...((manifest.declaredPermissions ?? []).map(permission => ({ ...permission, owner: id }))),
      ...((registration.permissions ?? []).map(permission => ({ ...permission, owner: id }))),
    ];
    const assertUnique = (label: string, values: readonly string[]) => {
      if (new Set(values).size !== values.length) {
        throw PlatformError.validation(`Extension "${id}" registers the same ${label} more than once`);
      }
    };

    assertUnique('permission', permissions.map(permission => permission.key));
    assertUnique('policy', (registration.policies ?? []).map(policy => policy.id));
    assertUnique('command', (registration.commands ?? []).map(command => command.descriptor.name));
    assertUnique('query', (registration.queries ?? []).map(query => query.descriptor.name));
    assertUnique('MCP tool', (registration.mcpTools ?? []).map(tool => tool.name));
    assertUnique('job', (registration.jobs ?? []).map(job => job.type));
    assertUnique('event subscription', (registration.events ?? []).map(event => event.event));
    assertUnique('provider', (registration.providers ?? []).map(provider => `${provider.kind}:${provider.id}`));

    for (const permission of permissions) this.deps.authorization.permissions.assertAvailable(permission);
    for (const policy of registration.policies ?? []) {
      if (this.deps.authorization.policies.has(policy.id)) {
        throw PlatformError.conflict(`Policy "${policy.id}" already registered`);
      }
    }

    const futurePermissionKeys = new Set(permissions.map(permission => permission.key));
    for (const command of registration.commands ?? []) {
      if (this.deps.commandBus.has(command.descriptor.name)) {
        throw PlatformError.conflict(`Command "${command.descriptor.name}" already registered`);
      }
      if (!futurePermissionKeys.has(command.descriptor.permission)) {
        this.deps.authorization.permissions.assertKnown(command.descriptor.permission, `command ${command.descriptor.name}`);
      }
    }
    for (const query of registration.queries ?? []) {
      if (this.deps.queryBus.has(query.descriptor.name)) {
        throw PlatformError.conflict(`Query "${query.descriptor.name}" already registered`);
      }
      if (!futurePermissionKeys.has(query.descriptor.permission)) {
        this.deps.authorization.permissions.assertKnown(query.descriptor.permission, `query ${query.descriptor.name}`);
      }
    }
    for (const tool of registration.mcpTools ?? []) {
      if (this.deps.mcpTools.has(tool.name)) throw PlatformError.conflict(`MCP tool "${tool.name}" already registered`);
    }

    const jobs = registration.jobs ?? [];
    this.deps.jobRegistry.validateBatch(jobs.map(job => ({ type: job.type, contract: job.jobContractV1 })));
    for (const job of jobs) {
      if (!job.schedule) continue;
      if (this.deps.recurring.specFor(job.type)) {
        throw PlatformError.conflict(`Recurring job "${job.type}" already registered`);
      }
      const spec = parseScheduleSpec(job.type, job.schedule);
      const contract = job.jobContractV1;
      const schema = contract?.versions[contract.currentVersion];
      if (!schema) {
        throw PlatformError.validation(`Scheduled extension job "${job.type}" requires current jobContractV1 metadata`);
      }
      const payload = scheduleOccurrencePayload(spec, new Date('2026-01-01T00:00:00.000Z'));
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw PlatformError.validation(
          `Scheduled extension job "${job.type}" cannot decode the recurring scheduler payload`,
          parsed.error.issues,
        );
      }
    }

    for (const event of registration.events ?? []) {
      this.deps.eventBus.getEvent(event.event);
      if (this.deps.eventBus.hasSubscription(id, event.event)) {
        throw PlatformError.conflict(`"${id}" already subscribes to "${event.event}"`);
      }
    }
    for (const provider of registration.providers ?? []) {
      if (this.deps.providers.has(provider.kind, provider.id)) {
        throw PlatformError.conflict(`Provider "${provider.kind}:${provider.id}" already registered`);
      }
    }
  }

  private createContext(definition: ExtensionDefinition<any>, config: unknown, actor: Actor): ExtensionContext<any> {
    const manifest = definition.manifest;
    const logger = this.deps.logger.child({ extension: manifest.id });
    const declaredProviderKinds = new Set<ProviderKind>(manifest.registeredProviders.map((p) => p.kind));
    const deps = this.deps;

    return {
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      platformVersion: deps.platformVersion,
      config,
      logger,
      store: new DbExtensionStore(deps.database, manifest.id),
      commands: {
        async execute(name, input, options) {
          // 使用 extension actor：CommandBus 的授權檢查會擋掉 manifest 沒宣告的權限
          return deps.commandBus.execute(name, input, {
            actor,
            idempotencyKey: options?.idempotencyKey,
            correlationId: options?.correlationId,
            channel: 'internal',
          });
        },
      },
      queries: {
        async execute(name, input, options) {
          return deps.queryBus.execute(name, input, { actor, correlationId: options?.correlationId, channel: 'internal' });
        },
      },
      jobs: {
        async enqueue(input) {
          if (!input.type.startsWith(`ext.${manifest.id}.`)) {
            throw PlatformError.forbidden(`Extension "${manifest.id}" may only enqueue jobs under "ext.${manifest.id}."`);
          }
          return deps.database.transaction((tx) => deps.jobs.enqueue(tx, input));
        },
        async requeue(jobId) {
          await deps.jobs.requeue(deps.database.db, jobId, `ext.${manifest.id}.`);
        },
        async retryDead(jobId) {
          await deps.jobs.retryDead(deps.database.db, jobId, `ext.${manifest.id}.`);
        },
      },
      mail: {
        async send(input) {
          deps.authorization.assert({ actor, permission: 'mail:send', resource: { type: 'mail-template', id: input.template.id } });
          return deps.mail.sendNow({ ...input, reference: `ext:${manifest.id}:${input.reference}` });
        },
        async enqueue(input) {
          deps.authorization.assert({ actor, permission: 'mail:send', resource: { type: 'mail-template', id: input.template.id } });
          return deps.mail.enqueue({ ...input, reference: `ext:${manifest.id}:${input.reference}` });
        },
      },
      getProvider<T extends AnyProvider>(kind: ProviderKind, id?: string): T {
        if (!declaredProviderKinds.has(kind) && !manifest.permissions.includes(`${kind}:read`)) {
          // 允許讀取自己註冊的 provider kind；其他 kind 需要明確權限
          throw PlatformError.forbidden(`Extension "${manifest.id}" did not declare access to ${kind} providers`);
        }
        return deps.providers.get<T>(kind, id);
      },
      secret(name) {
        if (!(manifest.requiredSecrets ?? []).includes(name)) {
          throw PlatformError.forbidden(`Extension "${manifest.id}" must declare secret "${name}" in requiredSecrets`);
        }
        return deps.secrets.get(name);
      },
      http: (httpOptions) => createHttpClient(httpOptions),
      now: () => new Date(),
    };
  }
}

export { SYSTEM_ACTOR };
