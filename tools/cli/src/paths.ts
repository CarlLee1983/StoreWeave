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

export function resolvePaths(): CommercePaths {
  const home = process.env.COMMERCE_HOME ?? '/opt/commerce';
  const configDir = process.env.COMMERCE_CONFIG_DIR ?? '/etc/commerce';
  const dataDir = process.env.COMMERCE_DATA_DIR ?? '/var/lib/commerce';
  const logDir = process.env.COMMERCE_LOG_DIR ?? '/var/log/commerce';
  return {
    home,
    configDir,
    dataDir,
    logDir,
    releasesDir: join(home, 'releases'),
    currentLink: join(home, 'current'),
    runDir: join(dataDir, 'run'),
    configFile: process.env.COMMERCE_CONFIG ?? join(configDir, 'commerce.yaml'),
    envFile: join(configDir, 'commerce.env'),
  };
}
