import { PLATFORM_VERSION, declaredInputKeys, inputObjectOf } from '@storeweave/contracts';
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
  const registeredJobs = (registration.jobs ?? []).map(job => job.type).sort();
  const declaredJobs = [...manifest.registeredJobs ?? []].sort();
  push(
    'registered jobs match the manifest',
    JSON.stringify(registeredJobs) === JSON.stringify(declaredJobs),
    `declared=${declaredJobs.join(',')} actual=${registeredJobs.join(',')}`,
  );
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

  // Extension 的輸入與 Core 的輸入是同一個答案：未知欄位一律擋（ADR 0024）。
  // 斷言的是「真的解析一次會被擋」而不是讀 `_def.unknownKeys`——
  // `.strict().catchall(z.unknown())` 會讓那個欄位仍是 'strict' 而未知鍵照樣通過。
  const registeredInputs = [...(registration.commands ?? []), ...(registration.queries ?? [])];
  const notObjects = registeredInputs
    .filter(({ descriptor }) => inputObjectOf(descriptor.input) === null)
    .map(({ descriptor }) => descriptor.name);
  const lax = registeredInputs
    .filter(({ descriptor }) => {
      const result = descriptor.input.safeParse({ __definitely_not_a_field__: 1 });
      return result.success || !result.error.issues.some((issue) => issue.code === 'unrecognized_keys');
    })
    .map(({ descriptor }) => descriptor.name)
    // 不是 object 的輸入沒有「未知欄位」可言，它吐的是 invalid_type；
    // 混進這份名單只會叫作者去找一個不存在的鍵。它由下面那一項各自報。
    .filter((name) => !notObjects.includes(name));
  push('command / query inputs reject unknown keys', lax.length === 0, lax.join(', '));

  // 收緊輸入的前提是 HTTP 橋接挑得出欄位：`apps/api/src/controllers/extensions.controller.ts`
  // 依 `declaredInputKeys` 過濾 query string，剝不出鍵時它只能整包往下送，
  // 於是帶 `?_t=` 的呼叫會撞上 strict 而回 400——那正是工單 51 要消掉的失敗（ADR 0024）。
  // union、array、intersection 這類輸入嚴格歸嚴格，但橋接讀不出它宣告了哪些鍵。
  const unpickable = registeredInputs
    .filter(({ descriptor }) => declaredInputKeys(descriptor.input) === null)
    .map(({ descriptor }) => descriptor.name);
  push(
    'command / query inputs are a plain object the HTTP bridge can pick keys from',
    unpickable.length === 0,
    unpickable.join(', '),
  );

  return checks;
}

export function assertExtensionContract(checks: readonly ContractCheck[]): void {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new Error(`Extension contract violations:\n${failed.map((f) => ` - ${f.name}${f.message ? `: ${f.message}` : ''}`).join('\n')}`);
  }
}
