import type { TargetProjectionFactory } from './projection-factory';
import { resolveTargetProjection } from './projection-factory';
import type { ReleaseDefinition } from './release-definition';
export type WorkerProjectionFactory<Contribution> = TargetProjectionFactory<'worker', Contribution>;
export function resolveWorkerProjection<Contribution>(definition: ReleaseDefinition, factory: WorkerProjectionFactory<Contribution>): Contribution {
  return resolveTargetProjection(definition, factory);
}
