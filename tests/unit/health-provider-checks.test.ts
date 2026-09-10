import { describe, expect, it, vi } from 'vitest';
import { doctor, type Runtime } from '@storeweave/kernel';

function runtimeForProvider(provider: { id: string; kind: 'payment'; healthCheck?: () => Promise<{ ok: boolean; message?: string }> }): Runtime {
  return {
    config: {
      security: { signingKeys: [] },
      store: { id: 'test-store' },
      paths: { dataDir: '/tmp', backupDir: '/tmp' },
      storage: { driver: 'local' },
    },
    database: { ping: vi.fn(async () => ({ ok: false, error: 'intentionally offline' })) },
    storage: { healthCheck: vi.fn(async () => undefined) },
    logger: { warn: vi.fn() },
    providers: {
      list: () => [provider],
      get: vi.fn(() => provider),
    },
    extensions: {
      list: () => [],
      find: () => undefined,
    },
    secrets: { has: () => false },
    platformVersion: '1.0.0',
  } as unknown as Runtime;
}

describe('commerce doctor provider health', () => {
  it('includes every enabled provider in the release gate', async () => {
    const healthCheck = vi.fn(async () => ({ ok: true, message: 'offline configuration verified' }));
    const checks = await doctor(runtimeForProvider({ id: 'ecpay', kind: 'payment', healthCheck }), {
      releaseVersion: 'test', configPath: '<test>',
    });

    expect(healthCheck).toHaveBeenCalledOnce();
    expect(checks).toContainEqual({
      name: 'provider:payment:ecpay',
      status: 'pass',
      detail: 'offline configuration verified',
    });
  });

  it('fails the release gate when a provider reports an unhealthy configuration', async () => {
    const checks = await doctor(runtimeForProvider({
      id: 'ecpay',
      kind: 'payment',
      healthCheck: async () => ({ ok: false, message: 'configuration incomplete' }),
    }), { releaseVersion: 'test', configPath: '<test>' });

    expect(checks).toContainEqual({
      name: 'provider:payment:ecpay',
      status: 'fail',
      detail: 'configuration incomplete',
    });
  });
});
