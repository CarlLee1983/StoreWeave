import { validateReleaseDefinition } from '../packages/platform/release/src/release-definition';
import { buildReleasePermissionCatalog, type RuntimeReleaseDefinition } from '../packages/platform/release/src/runtime';
import {
  assembleAdminProjection,
  type AdminProjection,
  type AdminProjectionAssemblyInput,
  type AdminRouteKey,
} from '../packages/platform/release/src/admin';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type SelectedAdminModule = {
  readonly adminProjectionReleaseDefinition?: unknown;
  readonly adminProjectionFactory?: unknown;
  readonly adminProjectionAssembly?: unknown;
  readonly adminProjection?: unknown;
};

/** Validate the exact selected release, its Admin target key, and its contribution assembly. */
export function validateAdminProjectionModule(
  moduleValue: unknown,
  expectedReleaseId: string,
  knownPermissions: readonly string[],
): void {
  const selectedModule = record(moduleValue, 'selected module') as SelectedAdminModule;
  const definition = validateReleaseDefinition(selectedModule.adminProjectionReleaseDefinition);
  if (definition.manifest.id !== expectedReleaseId) {
    throw new Error(`Selected Admin projection belongs to release "${definition.manifest.id}", expected "${expectedReleaseId}"`);
  }

  const factory = record(selectedModule.adminProjectionFactory, 'adminProjectionFactory');
  const declaration = definition.manifest.targets.admin;
  if (factory.target !== 'admin') throw new Error('Selected Admin projection factory must target "admin"');
  if (factory.key !== declaration.key) {
    throw new Error(`Selected Admin projection key "${String(factory.key)}" does not match release target key "${declaration.key}"`);
  }
  if (typeof factory.resolve !== 'function') throw new Error('Selected Admin projection factory must provide a resolve function');

  const assembly = record(selectedModule.adminProjectionAssembly, 'adminProjectionAssembly') as unknown as AdminProjectionAssemblyInput<AdminRouteKey>;
  const assembled = assembleAdminProjection(assembly);
  const projectionContext = { manifest: definition.manifest, declaration, target: 'admin' as const };
  const resolved = (factory.resolve as (value: typeof projectionContext) => unknown)(projectionContext);
  assertSameProjection(resolved, assembled, 'factory result');
  assertSameProjection(selectedModule.adminProjection, assembled, 'exported projection');
  assertKnownPermissions(assembled, knownPermissions, expectedReleaseId);
}

async function main(): Promise<void> {
  const selectedPath = process.argv[2];
  const expectedReleaseId = process.argv[3];
  const selectedRuntimePath = process.argv[4];
  if (!selectedPath) throw new Error('Selected Admin projection path is required');
  if (!expectedReleaseId) throw new Error('Expected selected release id is required');
  if (!selectedRuntimePath) throw new Error('Selected runtime release path is required');

  const selectedModule = await import(pathToFileURL(resolve(selectedPath)).href) as {
    readonly default?: unknown;
  };
  const runtimeModule = await import(pathToFileURL(resolve(selectedRuntimePath)).href) as {
    readonly release?: RuntimeReleaseDefinition<any>;
  };
  const runtimeRelease = runtimeModule.release;
  if (!runtimeRelease || runtimeRelease.id !== expectedReleaseId) {
    throw new Error(`Selected runtime belongs to release "${runtimeRelease?.id ?? '<missing>'}", expected "${expectedReleaseId}"`);
  }
  const knownPermissions = buildReleasePermissionCatalog(runtimeRelease);
  validateAdminProjectionModule(selectedModule, expectedReleaseId, knownPermissions);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertSameProjection<Route extends AdminRouteKey>(actual: unknown, expected: AdminProjection<Route>, label: string): void {
  const projection = record(actual, label);
  if (!Array.isArray(projection.contributionKeys)
    || projection.contributionKeys.length !== expected.contributionKeys.length
    || projection.contributionKeys.some((key, index) => key !== expected.contributionKeys[index])) {
    throw new Error(`Selected Admin ${label} contribution keys do not match the assembled contributions`);
  }
  if (!Array.isArray(projection.routes)
    || projection.routes.length !== expected.routes.length
    || projection.routes.some((route, index) => route !== expected.routes[index])) {
    throw new Error(`Selected Admin ${label} routes do not match the assembled contribution rows`);
  }
  if (!Array.isArray(projection.navSections)
    || projection.navSections.length !== expected.navSections.length
    || projection.navSections.some((section, index) => section !== expected.navSections[index])) {
    throw new Error(`Selected Admin ${label} navigation sections do not match the assembled contribution rows`);
  }
  if (projection.defaultRoute !== expected.defaultRoute) {
    throw new Error(`Selected Admin ${label} default route does not match the assembled contribution rows`);
  }
}

function assertKnownPermissions<Route extends AdminRouteKey>(
  projection: AdminProjection<Route>,
  knownPermissions: readonly string[],
  releaseId: string,
): void {
  const known = new Set(knownPermissions);
  for (const value of projection.routes) {
    const route = value as unknown as { readonly path: string; readonly permissions: readonly string[] };
    for (const permission of route.permissions) {
      if (!known.has(permission)) {
        throw new Error(`Admin route "${route.path}" references unknown permission "${permission}" in release "${releaseId}"`);
      }
    }
  }
}

const invokedScript = process.argv[1]?.replaceAll('\\', '/');
if (invokedScript && /(?:^|\/)scripts\/validate-admin-projection\.ts$/.test(invokedScript)) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
