import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  order: [] as string[],
  projection: undefined as unknown,
  bootstrapRelease: vi.fn(),
  Worker: vi.fn(),
  closeInReverse: vi.fn(),
  installShutdown: vi.fn(),
  withCleanupDeadline: vi.fn(),
  installFatalBoundary: vi.fn(),
  onceAsync: vi.fn(),
}));

vi.mock('@storeweave/release/bootstrap', () => ({ bootstrapRelease: state.bootstrapRelease }));
vi.mock('@storeweave/selected-worker', () => ({ get workerProjection() { return state.projection; } }));
vi.mock('@storeweave/kernel', () => ({
  Worker: state.Worker,
  closeInReverse: state.closeInReverse,
  installShutdown: state.installShutdown,
  withCleanupDeadline: state.withCleanupDeadline,
}));
vi.mock('../../apps/worker/src/fatal-boundary', () => ({
  installFatalBoundary: state.installFatalBoundary,
  onceAsync: state.onceAsync,
}));

function projection(releaseId = 'commerce') {
  return { target: 'worker', release: { id: releaseId, version: 'release-version' } };
}

function runtime(workerEnabled = true) {
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    config: { worker: { enabled: workerEnabled }, shutdown: { timeoutMs: 500 } },
    activateRelease: vi.fn(async () => { state.order.push('activate'); }),
    close: vi.fn(async () => { state.order.push('runtime.close'); }),
    jobRegistry: { types: () => ['commerce.test'] },
    events: { listSubscriptions: () => [] },
  };
}

async function loadMain(selected: unknown) {
  state.projection = selected;
  vi.resetModules();
  return (await import('../../apps/worker/src/main')).main;
}

afterEach(() => {
  state.order.length = 0;
  state.projection = undefined;
  vi.clearAllMocks();
  vi.resetModules();
});

describe('worker projection startup', () => {
  it.each(['base', 'commerce'])('bootstraps the %s release from its worker projection and preserves lifecycle order', async releaseId => {
    const selected = projection(releaseId);
    const value = runtime();
    const worker = {
      id: `${releaseId}-worker`,
      assertReady: vi.fn(() => { state.order.push('assertReady'); }),
      start: vi.fn(() => { state.order.push('start'); }),
      waitForFatal: vi.fn(() => { state.order.push('waitForFatal'); return new Promise(() => {}); }),
    };
    state.bootstrapRelease.mockImplementation(async () => {
      state.order.push('bootstrap');
      return { runtime: value };
    });
    state.Worker.mockImplementation(() => {
      state.order.push('construct');
      return worker;
    });
    state.installFatalBoundary.mockImplementation(() => { state.order.push('fatalBoundary'); });
    state.installShutdown.mockImplementation(() => { state.order.push('shutdown'); });
    value.logger.info.mockImplementation(() => { state.order.push('info'); });

    await (await loadMain(selected))();

    expect(state.bootstrapRelease).toHaveBeenCalledWith(selected.release, { loggerName: `${releaseId}-worker` });
    expect(state.Worker).toHaveBeenCalledWith(value);
    expect(worker.assertReady).toHaveBeenCalledOnce();
    expect(worker.start).toHaveBeenCalledOnce();
    expect(state.order).toEqual(['bootstrap', 'activate', 'construct', 'assertReady', 'start', 'waitForFatal', 'fatalBoundary', 'info', 'shutdown']);
  });

  it('rejects a missing worker projection before bootstrap or job execution', async () => {
    const main = await loadMain(undefined);

    await expect(main()).rejects.toThrow('Selected worker projection is missing');

    expect(state.bootstrapRelease).not.toHaveBeenCalled();
    expect(state.Worker).not.toHaveBeenCalled();
  });

  it('rejects a wrong-target projection before bootstrap or job execution', async () => {
    const selected = { ...projection(), target: 'server' };
    const main = await loadMain(selected);

    await expect(main()).rejects.toThrow('Selected worker projection has target "server"; expected "worker"');

    expect(state.bootstrapRelease).not.toHaveBeenCalled();
    expect(state.Worker).not.toHaveBeenCalled();
  });

  it.each([
    ['base', 'storeweave.yaml'],
    ['commerce', 'commerce.yaml'],
  ])('closes a disabled %s worker and reports its loaded config filename', async (releaseId, configFile) => {
    const value = runtime(false);
    state.bootstrapRelease.mockResolvedValue({ runtime: value, loaded: { sourcePath: `/tmp/${configFile}` } });
    state.closeInReverse.mockImplementation(async callbacks => {
      state.order.push('close');
      for (const callback of callbacks) await callback();
    });

    await (await loadMain(projection(releaseId)))();

    expect(value.logger.warn).toHaveBeenCalledWith(`worker is disabled in ${configFile}; exiting`);
    expect(value.close).toHaveBeenCalledOnce();
    expect(state.Worker).not.toHaveBeenCalled();
  });
});
