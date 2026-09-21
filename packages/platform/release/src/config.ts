import type { TargetProjectionFactory } from './projection-factory';
import { resolveTargetProjection } from './projection-factory';
import type { ReleaseDefinition } from './release-definition';
export type ConfigProjectionFactory<Config> = TargetProjectionFactory<'config', Config>;
export function resolveConfigProjection<Config>(definition: ReleaseDefinition, factory: ConfigProjectionFactory<Config>): Config {
  return resolveTargetProjection(definition, factory);
}
