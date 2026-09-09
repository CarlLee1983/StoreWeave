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
  type ExtensionRegistration,
  type ProviderKind,
} from '@storeweave/extension-sdk';
import { DbExtensionStore } from './extension-store';
import type { JobRegistry } from './job-registry';
import type { McpToolRegistry } from './mcp-registry';
import type { MailService } from '@storeweave/mail';

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

    // Extension 自己宣告的新權限先註冊，才能在後面的 command 檢查中通過
    for (const p of manifest.declaredPermissions ?? []) {
      this.deps.authorization.permissions.register({ key: p.key, description: p.description, owner: manifest.id });
    }
    for (const permission of manifest.permissions) {
      this.deps.authorization.permissions.assertKnown(permission, `extension ${manifest.id}`);
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

  private assertMatchesManifest(id: string, manifest: any, registration: ExtensionRegistration): void {
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
      manifest.registeredProviders.map((p: any) => `${p.kind}:${p.id}`),
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
