import { join } from 'node:path';

/** 目錄佈局可用環境變數覆寫，讓開發與測試不必動到系統路徑。 */
export interface CommercePaths {
  home: string;      // 程式：/opt/commerce
  configDir: string; // 設定：/etc/commerce
  dataDir: string;   // 資料：/var/lib/commerce
  logDir: string;    // 記錄：/var/log/commerce
  releasesDir: string;
  currentLink: string;
  runDir: string;
  configFile: string;
  envFile: string;
}

export function resolvePaths(releaseId = 'commerce'): CommercePaths {
  const name = releaseId === 'commerce' ? 'commerce' : 'storeweave';
  const legacy = (key: string) => releaseId === 'commerce' ? process.env[`COMMERCE_${key}`] : undefined;
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
    configFile: process.env.STOREWEAVE_CONFIG ?? legacy('CONFIG') ?? join(configDir, `${name}.yaml`),
    envFile: join(configDir, `${name}.env`),
  };
}
