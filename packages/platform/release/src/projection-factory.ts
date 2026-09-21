import type { ReleaseDefinition, ReleaseManifest, ReleaseTarget, ReleaseTargetDeclaration } from './release-definition';

export interface TargetProjectionContext<Target extends ReleaseTarget> {
  readonly manifest: ReleaseManifest;
  readonly declaration: ReleaseTargetDeclaration;
  readonly target: Target;
}

export interface TargetProjectionFactory<Target extends ReleaseTarget, Contribution> {
  readonly target: Target;
  /** Must match the target declaration selected in the common manifest. */
  readonly key: string;
  readonly resolve: (context: TargetProjectionContext<Target>) => Contribution;
}

export class ReleaseProjectionKeyMismatchError extends Error {
  constructor(target: ReleaseTarget, expected: string, received: string) {
    super(`Release target "${target}" requires factory key "${expected}", received "${received}"`);
    this.name = 'ReleaseProjectionKeyMismatchError';
  }
}

export function resolveTargetProjection<Target extends ReleaseTarget, Contribution>(
  definition: ReleaseDefinition,
  factory: TargetProjectionFactory<Target, Contribution>,
): Contribution {
  const declaration = definition.manifest.targets[factory.target];
  if (factory.key !== declaration.key) {
    throw new ReleaseProjectionKeyMismatchError(factory.target, declaration.key, factory.key);
  }
  return factory.resolve({ manifest: definition.manifest, declaration, target: factory.target });
}
