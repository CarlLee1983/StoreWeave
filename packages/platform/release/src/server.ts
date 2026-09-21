import type { TargetProjectionFactory } from './projection-factory';
import { resolveTargetProjection } from './projection-factory';
import type { ReleaseDefinition } from './release-definition';

export type ServerProjectionFactory<Contribution> = TargetProjectionFactory<'server', Contribution>;

export function resolveServerProjection<Contribution>(
  definition: ReleaseDefinition,
  factory: ServerProjectionFactory<Contribution>,
): Contribution {
  return resolveTargetProjection(definition, factory);
}
