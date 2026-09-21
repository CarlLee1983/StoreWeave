import { PLATFORM_VERSION } from '@storeweave/contracts';
import { validateReleaseDefinition, type ReleaseDefinition, type ReleaseTarget } from '@storeweave/release';
import packageJson from '../package.json';

export const COMMERCE_TARGET_KEYS = {
  server: 'commerce.server.v1', worker: 'commerce.worker.v1', admin: 'commerce.admin.v1',
  cli: 'commerce.cli.v1', config: 'commerce.config.v1', storefront: 'commerce.storefront.v1',
} as const satisfies Record<ReleaseTarget, string>;

// These are portable descriptors only; executable implementations remain target-local.
const COMMERCE_SELECTED = {
  modules: ['catalog', 'inventory', 'customer', 'cart', 'shipping', 'promotion', 'coupon', 'loyalty', 'order', 'invoice', 'notification', 'refund', 'rma', 'content', 'platform-site', 'platform-auth'],
  themes: ['default', 'editorial'],
  extensions: ['mock-payment', 'mock-invoice', 'ecpay', 'ecpay-invoice', 'ecpay-logistics', 'demo-erp', 'mcp'],
} as const;

/** Portable Commerce identity; importing it cannot load any target contribution. */
export const commerceReleaseDefinition: ReleaseDefinition = {
  manifest: {
    id: 'commerce',
    version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version,
    selected: COMMERCE_SELECTED,
    targets: Object.fromEntries(
      (Object.keys(COMMERCE_TARGET_KEYS) as ReleaseTarget[]).map(target => [target, { key: COMMERCE_TARGET_KEYS[target] }]),
    ) as ReleaseDefinition['manifest']['targets'],
    metadata: { baseVersion: PLATFORM_VERSION },
  },
};

export function validateCommerceReleaseDefinition(definition: unknown): ReleaseDefinition {
  const validated = validateReleaseDefinition(definition);
  if (validated.manifest.id !== 'commerce') {
    throw new CommerceReleaseSelectionError('release id must be "commerce"');
  }
  assertExactSelection(validated.manifest.selected.modules, COMMERCE_SELECTED.modules, 'modules');
  assertExactSelection(validated.manifest.selected.themes, COMMERCE_SELECTED.themes, 'themes');
  assertExactSelection(validated.manifest.selected.extensions, COMMERCE_SELECTED.extensions, 'extensions');
  for (const target of Object.keys(COMMERCE_TARGET_KEYS) as ReleaseTarget[]) {
    if (validated.manifest.targets[target].key !== COMMERCE_TARGET_KEYS[target]) {
      throw new CommerceReleaseSelectionError(`target "${target}" must use key "${COMMERCE_TARGET_KEYS[target]}"`);
    }
  }
  return validated;
}

export class CommerceReleaseSelectionError extends Error {
  constructor(message: string) {
    super(`Invalid Commerce release selection: ${message}`);
    this.name = 'CommerceReleaseSelectionError';
  }
}

export type CommerceProjectionFactoryInput<Factory> = Factory | readonly Factory[];

/** Require one contribution for a target before the shared projection invokes it. */
export function requireCommerceProjectionFactory<
  Target extends ReleaseTarget,
  Factory extends { readonly target: Target; readonly key: string },
>(target: Target, key: string, factories: readonly Factory[]): Factory {
  if (factories.length === 0) {
    throw new CommerceReleaseContributionError(`Commerce projection "${target}" is missing contribution key "${key}"`);
  }
  if (factories.length > 1) {
    throw new CommerceReleaseContributionError(`Commerce projection "${target}" has duplicate contribution key "${key}"`);
  }

  const factory = factories[0]!;
  if (factory.target !== target) {
    throw new CommerceReleaseContributionError(
      `Commerce projection "${target}" received target "${factory.target}" contribution key "${factory.key}"`,
    );
  }
  return factory;
}

export class CommerceReleaseContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommerceReleaseContributionError';
  }
}

export function commerceFactoryList<Factory>(input: CommerceProjectionFactoryInput<Factory>): readonly Factory[] {
  return Array.isArray(input) ? input : [input as Factory];
}

function assertExactSelection(actual: readonly string[], expected: readonly string[], name: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new CommerceReleaseSelectionError(`${name} must be exactly [${expected.join(', ')}]`);
  }
}
