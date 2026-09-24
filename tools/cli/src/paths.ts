import { join } from 'node:path';
import type { CliReleaseIdentity } from '@storeweave/release/cli';

/** 目錄佈局可用環境變數覆寫，讓開發與測試不必動到系統路徑。 */
export interface CliPaths {
  home: string;      // installation root
  configDir: string; // configuration directory
  dataDir: string;   // persistent data directory
  logDir: string;    // log directory
  releasesDir: string;
  currentLink: string;
  runDir: string;
  configFile: string;
  envFile: string;
}

export function resolvePaths(identity: CliReleaseIdentity): CliPaths {
  const name = identity.filesystemName;
  const legacy = (key: string) => identity.legacyEnvironmentPrefix
    ? process.env[`${identity.legacyEnvironmentPrefix}_${key}`]
    : undefined;
  const home = process.env.STOREWEAVE_HOME ?? legacy('HOME') ?? `/opt/${name}`;
  const configDir = process.env.STOREWEAVE_CONFIG_DIR ?? legacy('CONFIG_DIR') ?? `/etc/${name}`;
  const dataDir = process.env.STOREWEAVE_DATA_DIR ?? legacy('DATA_DIR') ?? `/var/lib/${name}`;
  const logDir = process.env.STOREWEAVE_LOG_DIR ?? legacy('LOG_DIR') ?? `/var/log/${name}`;
  return {
    home,
    configDir,
    dataDir,
    logDir,
    releasesDir: join(home, 'releases'),
    currentLink: join(home, 'current'),
    runDir: join(dataDir, 'run'),
    configFile: process.env.STOREWEAVE_CONFIG ?? legacy('CONFIG') ?? join(configDir, identity.configFilename),
    envFile: join(configDir, `${name}.env`),
  };
}
