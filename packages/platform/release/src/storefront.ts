import type { TargetProjectionFactory } from './projection-factory';
import { resolveTargetProjection } from './projection-factory';
import type { ReleaseDefinition } from './release-definition';
export type StorefrontProjectionFactory<Theme> = TargetProjectionFactory<'storefront', Theme>;
export function resolveStorefrontProjection<Theme>(definition: ReleaseDefinition, factory: StorefrontProjectionFactory<Theme>): Theme {
  return resolveTargetProjection(definition, factory);
}
