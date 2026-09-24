import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  order: [] as string[],
  bootstrapRelease: vi.fn(), createReleaseServer: vi.fn(), writeStartupHttpCatalog: vi.fn(),
  installShutdown: vi.fn(), resolveThemeAssetsDir: vi.fn(() => '/theme'),
  serverProjection: undefined as unknown,
}));

vi.mock('@storeweave/kernel', () => ({
  closeInReverse: async (closers: Array<() => Promise<void> | void>) => { for (const close of closers) await close(); },
  withCleanupDeadline: async (_timeout: number, close: () => Promise<void>) => close(),
  installShutdown: state.installShutdown,
}));
vi.mock('@storeweave/release/bootstrap', () => ({ bootstrapRelease: state.bootstrapRelease }));
vi.mock('@storeweave/selected-server', () => ({ get serverProjection() { return state.serverProjection; } }));
vi.mock('../../apps/api/src/release-server', () => ({ createReleaseServer: state.createReleaseServer }));
vi.mock('../../apps/api/src/theme-assets', () => ({ resolveThemeAssetsDir: state.resolveThemeAssetsDir }));
vi.mock('../../apps/api/src/http/catalog-artifact', () => ({ writeStartupHttpCatalog: state.writeStartupHttpCatalog }));

function runtime(autoMigrate = false) {
  const close = vi.fn(async () => { state.order.push('runtime.close'); });
  const activateRelease = vi.fn(async () => { state.order.push('activate'); return []; });
  return {
    config: { database: { autoMigrate }, http: { host: '127.0.0.1', port: 3000 }, shutdown: { timeoutMs: 1 }, store: { id: 'test' } },
    logger: { info: vi.fn() }, activatedRelease: Object.freeze({ id: 'effective', version: '1.2.3' }),
    activateRelease, close, extensions: { list: () => [] }, mcpTools: { size: 0 },
  };
}

function projection(releaseId = 'base') {
  return {
    release: { id: releaseId, version: 'release-version' },
    httpAdapter: { releaseId, controllers: vi.fn(() => []), startSession: vi.fn(async () => null) },
  };
}

async function start(selected: unknown = projection()) {
  state.serverProjection = selected;
  vi.resetModules();
  return (await import('../../apps/api/src/main')).main;
}

afterEach(() => {
  delete process.env.STOREWEAVE_HTTP_CATALOG_OUTPUT;
  delete process.env.STOREWEAVE_RELEASE_VERSION;
  state.order.length = 0;
  vi.clearAllMocks();
  state.serverProjection = undefined;
  vi.resetModules();
});

describe('API startup catalog export', () => {
  it('activates once, validates the server, exports the effective identity, then listens', async () => {
    process.env.STOREWEAVE_HTTP_CATALOG_OUTPUT = '/tmp/catalog.json';
    process.env.STOREWEAVE_RELEASE_VERSION = 'http-only-version';
    const selected = projection('base');
    const value = runtime();
    const app = { close: vi.fn(async () => { state.order.push('app.close'); }),
      listen: vi.fn(async () => { state.order.push('listen'); }), getHttpAdapter: () => ({ getInstance: () => ({ storeweaveHttpCatalog: [] }) }) };
    state.bootstrapRelease.mockImplementation(async () => { state.order.push('bootstrap'); return { runtime: value, loaded: { sourcePath: '/config' } }; });
    state.createReleaseServer.mockImplementation(async () => { state.order.push('server'); return app; });
    state.writeStartupHttpCatalog.mockImplementation(() => { state.order.push('artifact'); });

    await (await start(selected))();

    expect(state.order).toEqual(['bootstrap', 'activate', 'server', 'artifact', 'listen']);
    expect(state.bootstrapRelease).toHaveBeenCalledWith(selected.release, expect.objectContaining({ loggerName: 'base-api' }));
    expect(state.createReleaseServer).toHaveBeenCalledWith(expect.objectContaining({ httpAdapter: selected.httpAdapter }));
    expect(state.createReleaseServer).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ version: 'http-only-version' }) }));
    expect(state.writeStartupHttpCatalog).toHaveBeenCalledWith(expect.objectContaining({ output: '/tmp/catalog.json', runtime: value }));
    expect(state.writeStartupHttpCatalog.mock.calls[0]![0].runtime.activatedRelease).toEqual({ id: 'effective', version: '1.2.3' });
    expect(value.activateRelease).toHaveBeenCalledTimes(1);
  });

  it('does not create, export, or listen when activation fails and closes the runtime', async () => {
    const value = runtime();
    value.activateRelease.mockRejectedValueOnce(new Error('activation failed'));
    state.bootstrapRelease.mockResolvedValue({ runtime: value, loaded: { sourcePath: '/config' } });

    await expect((await start())()).rejects.toThrow('activation failed');

    expect(state.createReleaseServer).not.toHaveBeenCalled();
    expect(state.writeStartupHttpCatalog).not.toHaveBeenCalled();
    expect(value.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing HTTP adapter before release bootstrap', async () => {
    const main = await start({ release: { id: 'commerce', version: 'release-version' } });

    await expect(main()).rejects.toThrow('Server projection "commerce" is missing required HTTP adapter contribution');

    expect(state.bootstrapRelease).not.toHaveBeenCalled();
    expect(state.createReleaseServer).not.toHaveBeenCalled();
  });

  it('rejects an adapter owned by another release before release bootstrap', async () => {
    const wrongOwner = projection('base');
    wrongOwner.httpAdapter.releaseId = 'commerce';
    const main = await start(wrongOwner);

    await expect(main()).rejects.toThrow('Server projection "base" contains HTTP adapter owned by "commerce"');

    expect(state.bootstrapRelease).not.toHaveBeenCalled();
    expect(state.createReleaseServer).not.toHaveBeenCalled();
  });

  it('closes the server and runtime before listen when catalog publication fails', async () => {
    process.env.STOREWEAVE_HTTP_CATALOG_OUTPUT = '/tmp/catalog.json';
    const value = runtime();
    const app = { close: vi.fn(async () => { state.order.push('app.close'); }),
      listen: vi.fn(async () => { state.order.push('listen'); }), getHttpAdapter: () => ({ getInstance: () => ({ storeweaveHttpCatalog: [] }) }) };
    state.bootstrapRelease.mockResolvedValue({ runtime: value, loaded: { sourcePath: '/config' } });
    state.createReleaseServer.mockImplementation(async () => { state.order.push('server'); return app; });
    state.writeStartupHttpCatalog.mockImplementation(() => { state.order.push('artifact'); throw new Error('output failed'); });

    await expect((await start())()).rejects.toThrow('output failed');

    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(value.close).toHaveBeenCalledTimes(1);
  });
});
