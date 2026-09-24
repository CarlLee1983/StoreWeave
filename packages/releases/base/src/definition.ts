import { PLATFORM_VERSION } from '@storeweave/contracts';
import { validateReleaseDefinition, type ReleaseDefinition, type ReleaseTarget } from '@storeweave/release';
import packageJson from '../package.json';

export const BASE_TARGET_KEYS = {
  server: 'base.server.v1',
  worker: 'base.worker.v1',
  admin: 'base.admin.v1',
  cli: 'base.cli.v1',
  config: 'base.config.v1',
  storefront: 'base.storefront.v1',
} as const satisfies Record<ReleaseTarget, string>;

const BASE_SELECTED = {
  modules: ['platform-site', 'content', 'platform-auth'],
  themes: ['base', 'editorial'],
  extensions: [],
} as const;

/**
 * The portable Base release identity. Executable contributions live only in
 * target subpaths so importing this root cannot load a runtime target.
 */
export const baseReleaseDefinition: ReleaseDefinition = {
  manifest: {
    id: 'base',
    version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version,
    selected: BASE_SELECTED,
    targets: Object.fromEntries(
      (Object.keys(BASE_TARGET_KEYS) as ReleaseTarget[]).map(target => [target, { key: BASE_TARGET_KEYS[target] }]),
    ) as ReleaseDefinition['manifest']['targets'],
    metadata: { baseVersion: PLATFORM_VERSION },
  },
};

/** Rejects selections that would no longer be equivalent to the legacy Base release. */
export function validateBaseReleaseDefinition(definition: unknown): ReleaseDefinition {
  const validated = validateReleaseDefinition(definition);
  if (validated.manifest.id !== 'base') {
    throw new BaseReleaseSelectionError('manifest.id must be "base"');
  }
  assertExactSelection(validated.manifest.selected.modules, BASE_SELECTED.modules, 'modules');
  assertExactSelection(validated.manifest.selected.themes, BASE_SELECTED.themes, 'themes');
  assertExactSelection(validated.manifest.selected.extensions, BASE_SELECTED.extensions, 'extensions');
  for (const target of Object.keys(BASE_TARGET_KEYS) as ReleaseTarget[]) {
    if (validated.manifest.targets[target].key !== BASE_TARGET_KEYS[target]) {
      throw new BaseReleaseSelectionError(`target "${target}" must use key "${BASE_TARGET_KEYS[target]}"`);
    }
  }
  return validated;
}

export class BaseReleaseSelectionError extends Error {
  constructor(message: string) {
    super(`Invalid Base release selection: ${message}`);
    this.name = 'BaseReleaseSelectionError';
  }
}

function assertExactSelection(actual: readonly string[], expected: readonly string[], name: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new BaseReleaseSelectionError(`${name} must be exactly [${expected.join(', ')}]`);
  }
}
