import { PLATFORM_VERSION } from '@storeweave/contracts';
import { checkPlatformCompatibility } from './compat';
import { validateManifestShape } from './manifest';
import { createTestExtensionContext } from './testing';
import type { ExtensionDefinition } from './registration';

export interface ContractCheck {
  name: string;
  ok: boolean;
  message?: string;
}

export interface ContractTestOptions {
  platformVersion?: string;
  /** 平台已知的事件名稱（core + 其他 extension）。 */
  knownEvents?: readonly string[];
  /** 平台已知的權限鍵。 */
  knownPermissions?: readonly string[];
  /** 一份合法設定範例，用來驗證 configuration schema。 */
  sampleConfig?: unknown;
  /** 一份預期不合法的設定，用來確認 schema 真的會擋。 */
  invalidConfig?: unknown;
  providers?: Parameters<typeof createTestExtensionContext>[0]['providers'];
  commands?: Parameters<typeof createTestExtensionContext>[0]['commands'];
  queries?: Parameters<typeof createTestExtensionContext>[0]['queries'];
  secrets?: Record<string, string>;
}

/**
 * Extension Contract Test 工具。
 * 在不啟動平台、不連資料庫的情況下，驗證 Extension 是否遵守 SDK 契約。
 */
export async function runExtensionContractChecks(
  definition: ExtensionDefinition<any>,
  options: ContractTestOptions = {},
): Promise<ContractCheck[]> {
  const checks: ContractCheck[] = [];
  const push = (name: string, ok: boolean, message?: string) => checks.push({ name, ok, message });
  const platformVersion = options.platformVersion ?? PLATFORM_VERSION;
  const manifest = definition.manifest;

  try {
    validateManifestShape(manifest);
    push('manifest shape is valid', true);
  } catch (err) {
    push('manifest shape is valid', false, (err as Error).message);
    return checks;
  }

  const compat = checkPlatformCompatibility(manifest, platformVersion);
  push('platform version compatible', compat.compatible, compat.reason);

  if (options.knownEvents) {
    const unknown = manifest.subscribedEvents.filter((e) => !options.knownEvents!.includes(e));
    push('subscribed events exist in the platform catalog', unknown.length === 0, unknown.join(', '));
  }
  if (options.knownPermissions) {
    const declared = new Set((manifest.declaredPermissions ?? []).map((p) => p.key));
    const unknown = manifest.permissions.filter((p) => !options.knownPermissions!.includes(p) && !declared.has(p));
    push('requested permissions are known', unknown.length === 0, unknown.join(', '));
  }

  const sample = options.sampleConfig ?? {};
  const parsedConfig = manifest.configuration.safeParse(sample);
  push('sample configuration validates', parsedConfig.success, parsedConfig.success ? undefined : JSON.stringify(parsedConfig.error.issues));
  if (options.invalidConfig !== undefined) {
    const bad = manifest.configuration.safeParse(options.invalidConfig);
    push('invalid configuration is rejected', !bad.success);
  }
  push('manifest declares no secret values', !JSON.stringify({ ...manifest, configuration: undefined }).match(/(sk_live|password"\s*:\s*"[^"]+)/i));

  if (!parsedConfig.success) return checks;

  const ctx = createTestExtensionContext({
    extensionId: manifest.id,
    extensionVersion: manifest.version,
    platformVersion,
    config: parsedConfig.data,
    providers: options.providers,
    commands: options.commands,
    queries: options.queries,
    secrets: options.secrets,
  });

  let registration;
  try {
    registration = await definition.setup(ctx);
    push('setup() completes without side effects on the platform', true);
  } catch (err) {
    push('setup() completes without side effects on the platform', false, (err as Error).message);
    return checks;
  }

  const registeredCommands = (registration.commands ?? []).map((c) => c.descriptor.name).sort();
  const declaredCommands = [...manifest.registeredCommands].sort();
  push(
    'registered commands match the manifest',
    JSON.stringify(registeredCommands) === JSON.stringify(declaredCommands),
    `declared=${declaredCommands.join(',')} actual=${registeredCommands.join(',')}`,
  );

  const registeredQueries = (registration.queries ?? []).map((q) => q.descriptor.name).sort();
  const declaredQueries = [...manifest.registeredQueries].sort();
  push(
    'registered queries match the manifest',
    JSON.stringify(registeredQueries) === JSON.stringify(declaredQueries),
    `declared=${declaredQueries.join(',')} actual=${registeredQueries.join(',')}`,
  );

  const registeredProviders = (registration.providers ?? []).map((p) => `${p.kind}:${p.id}`).sort();
  const declaredProviders = manifest.registeredProviders.map((p) => `${p.kind}:${p.id}`).sort();
  push(
    'registered providers match the manifest',
    JSON.stringify(registeredProviders) === JSON.stringify(declaredProviders),
    `declared=${declaredProviders.join(',')} actual=${registeredProviders.join(',')}`,
  );

  const handledEvents = (registration.events ?? []).map((e) => e.event).sort();
  const declaredEvents = [...manifest.subscribedEvents].sort();
  push(
    'event subscriptions match the manifest',
    JSON.stringify(handledEvents) === JSON.stringify(declaredEvents),
    `declared=${declaredEvents.join(',')} actual=${handledEvents.join(',')}`,
  );

  const commandsUnderNamespace = registeredCommands.filter((n) => !n.startsWith(`ext.${manifest.id}.`));
  push(
    'extension commands live under the ext.<id>. namespace',
    commandsUnderNamespace.length === 0,
    commandsUnderNamespace.join(', '),
  );

  const jobTypes = (registration.jobs ?? []).map((j) => j.type);
  const badJobTypes = jobTypes.filter((t) => !t.startsWith(`ext.${manifest.id}.`));
  push('extension jobs live under the ext.<id>. namespace', badJobTypes.length === 0, badJobTypes.join(', '));

  const duplicateJobTypes = jobTypes.filter((t, i) => jobTypes.indexOf(t) !== i);
  push('job types are unique', duplicateJobTypes.length === 0, duplicateJobTypes.join(', '));

  return checks;
}

export function assertExtensionContract(checks: readonly ContractCheck[]): void {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new Error(`Extension contract violations:\n${failed.map((f) => ` - ${f.name}${f.message ? `: ${f.message}` : ''}`).join('\n')}`);
  }
}
