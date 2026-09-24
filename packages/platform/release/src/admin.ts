import type { ReleaseDefinition } from './release-definition';
import { resolveTargetProjection, type TargetProjectionFactory } from './projection-factory';

export interface AdminNavBadge {
  readonly text: string;
  readonly variant?: 'error';
}

/** One browser-safe Admin route: URL, navigation, permissions, and UI entry stay together. */
export interface AdminRouteDefinition<
  Path extends string = string,
  NavText extends string = string,
  Icon extends string = string,
  Section extends string = string,
  Context = never,
  UIEntry = unknown,
> {
  readonly path: Path;
  readonly navLabel: NavText;
  readonly icon: Icon;
  readonly section: Section;
  readonly title: NavText;
  readonly subtitle: NavText;
  readonly permissions: readonly string[];
  readonly module?: string;
  readonly action?: { readonly label: NavText; readonly targetId: string };
  readonly badge?: (context: Context) => AdminNavBadge | null;
  readonly render: (context: Context) => UIEntry;
}

export interface AdminRouteKey {
  readonly path: string;
  readonly section: string;
}

export interface AdminContribution<Route extends AdminRouteKey = AdminRouteKey> {
  readonly key: string;
  readonly routes: readonly Route[];
}

export interface AdminProjection<Route extends AdminRouteKey = AdminRouteKey> {
  readonly contributionKeys: readonly string[];
  readonly routes: readonly Route[];
  readonly navSections: readonly Route['section'][];
  readonly defaultRoute: Route['path'];
}

export interface AdminProjectionAssemblyInput<Route extends AdminRouteKey = AdminRouteKey> {
  readonly requiredContributionKeys: readonly string[];
  readonly contributions: readonly AdminContribution<Route>[];
  readonly defaultRoute: Route['path'];
}

export type AdminProjectionFactory<Contribution> = TargetProjectionFactory<'admin', Contribution>;

export class AdminProjectionAssemblyError extends Error {
  constructor(message: string) {
    super(`Invalid Admin projection: ${message}`);
    this.name = 'AdminProjectionAssemblyError';
  }
}

/**
 * Validates and flattens the exact build-time contribution set. It has no browser,
 * React, or server dependency, so the Admin target can run it before bundling.
 */
export function assembleAdminProjection<Route extends AdminRouteKey>(input: AdminProjectionAssemblyInput<Route>): AdminProjection<Route> {
  const requiredKeys = uniqueNonEmptyStrings(input.requiredContributionKeys, 'requiredContributionKeys');
  if (requiredKeys.length === 0) fail('requiredContributionKeys must contain at least one key');
  if (!Array.isArray(input.contributions)) fail('contributions must be an array');

  const contributions = input.contributions as readonly unknown[];
  const byKey = new Map<string, { routes: readonly unknown[] }>();
  for (const [index, value] of contributions.entries()) {
    const contribution = record(value, `contributions[${index}]`);
    const key = requiredString(contribution.key, `contributions[${index}].key`);
    if (byKey.has(key)) fail(`duplicate contribution key "${key}"`);
    if (!Array.isArray(contribution.routes) || contribution.routes.length === 0) {
      fail(`contribution "${key}" must declare at least one route`);
    }
    byKey.set(key, { routes: contribution.routes });
  }

  const unexpected = [...byKey.keys()].filter(key => !requiredKeys.includes(key));
  if (unexpected.length > 0) fail(`unexpected contribution key${unexpected.length === 1 ? '' : 's'} ${quote(unexpected)}`);
  const missing = requiredKeys.filter(key => !byKey.has(key));
  if (missing.length > 0) fail(`missing contribution key${missing.length === 1 ? '' : 's'} ${quote(missing)}`);

  const routes: unknown[] = [];
  const routePaths = new Set<string>();
  const navSections: string[] = [];
  for (const key of requiredKeys) {
    const contribution = byKey.get(key)!;
    for (const [index, value] of contribution.routes.entries()) {
      const path = validateRoute(value, key, index);
      if (routePaths.has(path)) fail(`duplicate route path "${path}"`);
      routePaths.add(path);
      const route = value as AdminRouteKey;
      routes.push(route);
      if (!navSections.includes(route.section)) navSections.push(route.section);
    }
  }

  const defaultRoute = requiredString(input.defaultRoute, 'defaultRoute');
  if (!routePaths.has(defaultRoute)) fail(`default route "${defaultRoute}" is not contributed`);

  return {
    contributionKeys: requiredKeys,
    routes: routes as Route[],
    navSections: navSections as Route['section'][],
    defaultRoute: defaultRoute as Route['path'],
  };
}

export function resolveAdminProjection<Contribution>(
  definition: ReleaseDefinition,
  factory: AdminProjectionFactory<Contribution>,
): Contribution {
  return resolveTargetProjection(definition, factory);
}

function validateRoute(value: unknown, contributionKey: string, index: number): string {
  const path = `contribution "${contributionKey}" routes[${index}]`;
  const route = record(value, path);
  const routePath = requiredString(route.path, `${path}.path`);
  if (!/^[a-z][a-z0-9-]*$/.test(routePath)) fail(`${path}.path "${routePath}" must be a lowercase route key`);
  requiredString(route.navLabel, `${path}.navLabel`);
  requiredString(route.icon, `${path}.icon`);
  requiredString(route.section, `${path}.section`);
  requiredString(route.title, `${path}.title`);
  requiredString(route.subtitle, `${path}.subtitle`);
  if (typeof route.render !== 'function') fail(`${path}.render must be a UI entry function`);

  if (!Array.isArray(route.permissions)) fail(`${path}.permissions must be an array of permission keys`);
  const permissions = uniqueNonEmptyStrings(route.permissions, `${path}.permissions`);
  const invalidPermission = permissions.find(permission => !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(permission));
  if (invalidPermission !== undefined) {
    fail(`${path}.permissions contains invalid key "${invalidPermission}"; expected a key such as "catalog:read"`);
  }

  if (route.module !== undefined) requiredString(route.module, `${path}.module`);
  if (route.action !== undefined) {
    const action = record(route.action, `${path}.action`);
    onlyKeys(action, ['label', 'targetId'], `${path}.action`);
    requiredString(action.label, `${path}.action.label`);
    requiredString(action.targetId, `${path}.action.targetId`);
  }
  if (route.badge !== undefined && typeof route.badge !== 'function') {
    fail(`${path}.badge must be a UI badge function`);
  }
  return routePath;
}

function uniqueNonEmptyStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array of non-empty strings`);
  const values = value.map((entry, index) => requiredString(entry, `${path}[${index}]`));
  const duplicate = values.find((entry, index) => values.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(`${path} contains duplicate key "${duplicate}"`);
  return values;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected !== undefined) fail(`${path} has unexpected field "${unexpected}"`);
  const missing = allowed.find(key => !(key in value));
  if (missing !== undefined) fail(`${path}.${missing} is required`);
}

function quote(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ');
}

function fail(message: string): never {
  throw new AdminProjectionAssemblyError(message);
}
