import { loadConfig, type LoadedConfig } from '@storeweave/config';
import { createLogger, createRuntime, type Runtime, type StorefrontTheme } from '@storeweave/kernel';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { defaultTheme } from '@storeweave/theme-default';
import { PlatformError } from '@storeweave/contracts';
import { AVAILABLE_EXTENSIONS, coreModules } from './modules';

/** 這個 Release 內建的 Theme。Theme 與 Extension 一樣是建置時組裝的。 */
export const AVAILABLE_THEMES: Record<string, StorefrontTheme> = {
  default: defaultTheme,
};

export interface BootstrapResult {
  runtime: Runtime;
  loaded: LoadedConfig;
  theme: StorefrontTheme;
}

/**
 * API、Worker、CLI 共用的啟動路徑。
 * 三者拿到的是同一份設定、同一組模組、同一批 Extension —— 行為不可能分歧。
 */
export async function bootstrap(options: {
  configPath?: string;
  loggerName: string;
  /**
   * 設定寫 `logging.destination: stdout` 時，日誌改寫到哪裡。CLI 傳 `stderr`：
   * 指令的答案要留給 stdout。設定寫 `file` 的部署不受影響——那是維運選的地方。
   */
  logDestination?: 'stdout' | 'stderr';
}): Promise<BootstrapResult> {
  const loaded = loadConfig(options.configPath);
  const { config, secrets } = loaded;

  const logger = createLogger({
    level: config.logging.level,
    destination: config.logging.destination === 'stdout'
      ? options.logDestination ?? 'stdout'
      : config.logging.destination,
    file: config.logging.file,
    name: options.loggerName,
  });

  const theme = AVAILABLE_THEMES[config.theme.id];
  if (!theme) {
    throw PlatformError.validation(
      `Theme "${config.theme.id}" is not part of this release. Available: ${Object.keys(AVAILABLE_THEMES).join(', ')}`,
    );
  }
  const themeOptions = theme.optionsSchema.safeParse(config.theme.options);
  if (!themeOptions.success) {
    throw PlatformError.validation(`Invalid theme options for "${theme.id}"`, themeOptions.error.issues);
  }
  config.theme.options = themeOptions.data as Record<string, unknown>;

  const providers = new ProviderRegistry(logger);
  const runtime = await createRuntime({
    config,
    secrets,
    logger,
    providers,
    modules: coreModules({
      providers,
      defaultCurrency: config.store.currency,
      orderNumberPrefix: config.store.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SW',
      timezone: config.store.timezone,
      locale: config.store.locale,
    }),
    availableExtensions: AVAILABLE_EXTENSIONS,
  });

  return { runtime, loaded, theme };
}
