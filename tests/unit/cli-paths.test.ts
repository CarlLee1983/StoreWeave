import { afterEach, describe, expect, it } from 'vitest';
import { cliProjection as baseCli } from '../../packages/releases/base/src/cli';
import { cliProjection as commerceCli } from '../../packages/releases/commerce/src/cli';
import { resolvePaths } from '../../tools/cli/src/paths';

const pathEnvironment = [
  'STOREWEAVE_HOME', 'STOREWEAVE_CONFIG_DIR', 'STOREWEAVE_DATA_DIR', 'STOREWEAVE_LOG_DIR', 'STOREWEAVE_CONFIG',
  'COMMERCE_HOME', 'COMMERCE_CONFIG_DIR', 'COMMERCE_DATA_DIR', 'COMMERCE_LOG_DIR', 'COMMERCE_CONFIG',
] as const;
const originalEnvironment = new Map(pathEnvironment.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of pathEnvironment) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('CLI path identity', () => {
  it('preserves Commerce STOREWEAVE overrides and legacy COMMERCE fallbacks', () => {
    for (const key of pathEnvironment) delete process.env[key];
    process.env.COMMERCE_HOME = '/legacy/commerce';
    process.env.COMMERCE_CONFIG_DIR = '/legacy/config';
    process.env.COMMERCE_DATA_DIR = '/legacy/data';
    process.env.COMMERCE_LOG_DIR = '/legacy/logs';
    process.env.COMMERCE_CONFIG = '/legacy/config/commerce.yaml';

    expect(resolvePaths(commerceCli.identity)).toMatchObject({
      home: '/legacy/commerce',
      configDir: '/legacy/config',
      dataDir: '/legacy/data',
      logDir: '/legacy/logs',
      configFile: '/legacy/config/commerce.yaml',
      envFile: '/legacy/config/commerce.env',
    });
  });

  it('keeps STOREWEAVE environment values ahead of the Commerce legacy aliases', () => {
    for (const key of pathEnvironment) delete process.env[key];
    process.env.STOREWEAVE_HOME = '/configured/home';
    process.env.STOREWEAVE_CONFIG_DIR = '/configured/config';
    process.env.STOREWEAVE_DATA_DIR = '/configured/data';
    process.env.STOREWEAVE_LOG_DIR = '/configured/logs';
    process.env.STOREWEAVE_CONFIG = '/configured/config/current.yaml';
    process.env.COMMERCE_HOME = '/legacy/commerce';
    process.env.COMMERCE_CONFIG = '/legacy/config/commerce.yaml';

    expect(resolvePaths(commerceCli.identity)).toMatchObject({
      home: '/configured/home',
      configDir: '/configured/config',
      dataDir: '/configured/data',
      logDir: '/configured/logs',
      configFile: '/configured/config/current.yaml',
    });
  });

  it('does not use Commerce legacy environment variables for Base', () => {
    for (const key of pathEnvironment) delete process.env[key];
    process.env.COMMERCE_HOME = '/legacy/commerce';
    process.env.COMMERCE_CONFIG = '/legacy/config/commerce.yaml';

    expect(resolvePaths(baseCli.identity)).toMatchObject({
      home: '/opt/storeweave',
      configDir: '/etc/storeweave',
      dataDir: '/var/lib/storeweave',
      logDir: '/var/log/storeweave',
      configFile: '/etc/storeweave/storeweave.yaml',
      envFile: '/etc/storeweave/storeweave.env',
    });
  });

  it('uses the config projection filename even when it differs from the filesystem name', () => {
    for (const key of pathEnvironment) delete process.env[key];

    expect(resolvePaths({ ...commerceCli.identity, configFilename: 'release-settings.yaml' }).configFile)
      .toBe('/etc/commerce/release-settings.yaml');
  });
});
