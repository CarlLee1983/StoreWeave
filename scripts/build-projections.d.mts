export type BuildTarget = 'server' | 'worker' | 'admin' | 'cli';

export interface BuildReleaseSelection {
  runtime: string;
  server?: string;
  worker?: string;
  adminProjection?: string;
  cli?: string;
  configProjection?: string;
  storefrontProjection?: string;
  admin?: boolean;
}

export interface BuildProjection {
  target: BuildTarget;
  entry: string;
  projectionField: string;
  artifact: string;
  alias: string;
  releaseId: string;
  source: string;
  enabled: boolean;
  status: 'built' | 'disabled' | 'skipped';
}

export interface ProjectionMetadata {
  releaseId: string;
  target: BuildTarget;
  source: string;
  artifact: string | null;
  status: 'built' | 'disabled' | 'skipped';
  inputCount: number;
  inputsChecksum: string | null;
}

export interface RuntimeProjectionSource {
  releaseId: string;
  target: 'config' | 'storefront';
  source: string;
}

export const ADMIN_PROJECTION_PROVENANCE: string;

export function createAdminProjectionProvenance(options: {
  root: string;
  releaseId: string;
  source: string;
  inputs: string[];
  bundle: Record<string, {
    type: 'asset' | 'chunk';
    source?: string | Uint8Array;
    code?: string;
    modules?: Record<string, unknown>;
  }>;
}): ProjectionMetadata & {
  format: 'storeweave.admin-projection.v1';
  inputs: string[];
  inputGraphChecksum: string;
  artifacts: { path: string; sha256: string }[];
  artifactTreeChecksum: string;
};

export function validateAdminProjectionProvenance(options: {
  root: string;
  releaseId: string;
  source: string;
  directory: string;
  forbiddenSources?: string[];
}): ProjectionMetadata;

export const BUILD_TARGETS: readonly Omit<BuildProjection, 'releaseId' | 'source' | 'enabled' | 'status'>[];

export function resolveBuildProjections(options: {
  root: string;
  releaseId: string;
  release: BuildReleaseSelection;
  skipAdmin?: boolean;
}): BuildProjection[];

export const RUNTIME_PROJECTION_TARGETS: readonly { target: 'config' | 'storefront'; projectionField: 'configProjection' | 'storefrontProjection' }[];

export function resolveRuntimeProjectionSources(options: {
  root: string;
  releaseId: string;
  release: BuildReleaseSelection;
  runtimeProjectionSources: { config: string; storefront: string };
}): RuntimeProjectionSource[];

export function projectionAliases(root: string, releaseId: string, release: BuildReleaseSelection, target: string): Record<string, string>;

export function validateProjectionGraph(options: {
  root: string;
  releaseId: string;
  target: BuildTarget;
  source: string;
  artifact: string;
  inputs: string[];
  forbiddenSources?: string[];
}): ProjectionMetadata;

export function projectionMetadata(options: {
  releaseId: string;
  target: BuildTarget;
  source: string;
  artifact: string;
  status: 'built' | 'disabled' | 'skipped';
  inputs?: string[];
}): ProjectionMetadata;

export function validateBuildGraph(options: {
  root: string;
  releaseId: string;
  target: string;
  inputs: string[];
  forbiddenSources?: string[];
}): string[];
