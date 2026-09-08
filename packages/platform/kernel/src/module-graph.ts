import semver from 'semver';
import { PlatformError } from '@storeweave/contracts';
import { PermissionRegistry } from '@storeweave/authorization';
import type { ModuleDependency, PlatformModule } from './module';

const MODULE_NAME = /^[a-z][a-z0-9-]*$/;
const CAPABILITY_NAME = /^[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/;
const DATA_NAME = /^[a-z][a-z0-9_]*$/;
const compareNames = (a: PlatformModule, b: PlatformModule) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Validate the complete release before constructing a database or registering a handler. */
export function validateModuleGraph(
  modules: readonly PlatformModule[],
  baseVersion: string,
): readonly PlatformModule[] {
  const fail = (message: string): never => { throw PlatformError.validation(`Module graph: ${message}`); };
  if (!semver.valid(baseVersion)) fail(`invalid Base version "${baseVersion}"`);
  const sorted = [...modules].sort(compareNames);
  const byName = new Map<string, PlatformModule>();
  const claims = new Map<string, string>();
  const permissions = new PermissionRegistry();

  function claim(kind: string, key: string, owner: string): void {
    const id = `${kind}:${key}`;
    const existing = claims.get(id);
    if (existing) fail(`${kind} "${key}" is declared by both "${existing}" and "${owner}"`);
    claims.set(id, owner);
  }

  for (const mod of sorted) {
    if (!MODULE_NAME.test(mod.name)) fail(`invalid module name "${mod.name}"`);
    if (byName.has(mod.name)) fail(`duplicate module "${mod.name}"`);
    byName.set(mod.name, mod);
    if (!semver.valid(mod.version)) fail(`module "${mod.name}" has invalid version "${mod.version}"`);
    if (!semver.validRange(mod.baseVersionRange)) fail(`module "${mod.name}" has invalid Base range "${mod.baseVersionRange}"`);
    if (!semver.satisfies(baseVersion, mod.baseVersionRange, { includePrerelease: true })) {
      fail(`module "${mod.name}" requires Base ${mod.baseVersionRange}, running ${baseVersion}`);
    }
    for (const capability of mod.capabilities?.provides ?? []) {
      if (!CAPABILITY_NAME.test(capability)) fail(`module "${mod.name}" provides invalid capability "${capability}"`);
      claim('capability', capability, mod.name);
    }
    for (const resource of mod.data?.owns ?? []) {
      if (!DATA_NAME.test(resource)) fail(`module "${mod.name}" owns invalid data resource "${resource}"`);
      claim('data resource', resource, mod.name);
    }
    if (mod.migrations) {
      if (!MODULE_NAME.test(mod.migrations.module)) fail(`module "${mod.name}" has invalid migration owner "${mod.migrations.module}"`);
      claim('migration owner', mod.migrations.module, mod.name);
      const ids = new Set<string>();
      for (const migration of mod.migrations.migrations) {
        if (ids.has(migration.id)) fail(`module "${mod.name}" repeats migration "${migration.id}"`);
        ids.add(migration.id);
      }
    }
    for (const permission of mod.permissions ?? []) {
      if (permission.owner !== mod.name) fail(`permission "${permission.key}" has owner "${permission.owner}", expected "${mod.name}"`);
      claim('permission', permission.key, mod.name);
      permissions.register(permission);
    }
    for (const policy of mod.policies ?? []) {
      if (policy.owner !== mod.name) fail(`policy "${policy.id}" has owner "${policy.owner}", expected "${mod.name}"`);
      claim('policy', policy.id, mod.name);
    }
    for (const event of mod.events ?? []) claim('event', event.name, mod.name);
    for (const command of mod.commands ?? []) claim('command', command.descriptor.name, mod.name);
    for (const query of mod.queries ?? []) claim('query', query.descriptor.name, mod.name);
    for (const job of mod.jobs ?? []) claim('job', job.type, mod.name);
    for (const sub of mod.subscribers ?? []) claim('subscription', `${mod.name}:${sub.eventName}`, mod.name);
  }

  function dependency(mod: PlatformModule, dep: ModuleDependency, optional: boolean): PlatformModule | undefined {
    if (!MODULE_NAME.test(dep.name) || !semver.validRange(dep.versionRange)) {
      fail(`module "${mod.name}" has invalid dependency "${dep.name}@${dep.versionRange}"`);
    }
    const target = byName.get(dep.name);
    if (!target) {
      if (!optional) fail(`module "${mod.name}" requires missing module "${dep.name}"`);
      return undefined;
    }
    if (!semver.satisfies(target.version, dep.versionRange, { includePrerelease: true })) {
      fail(`module "${mod.name}" requires ${dep.name}@${dep.versionRange}, found ${target.version}`);
    }
    return target;
  }

  const edges = new Map<string, PlatformModule[]>();
  for (const mod of sorted) {
    const staticTargets: PlatformModule[] = [];
    const seenDependencies = new Set<string>();
    for (const [optional, deps] of [[false, mod.dependencies?.required], [true, mod.dependencies?.optional]] as const) {
      for (const dep of deps ?? []) {
        if (seenDependencies.has(dep.name)) fail(`module "${mod.name}" repeats dependency "${dep.name}"`);
        seenDependencies.add(dep.name);
        const target = dependency(mod, dep, optional);
        if (target) staticTargets.push(target);
      }
    }
    edges.set(mod.name, staticTargets.sort(compareNames));
    const bindings = new Map<string, string>();
    for (const binding of mod.capabilities?.bound ?? []) {
      if (bindings.has(binding.capability)) fail(`module "${mod.name}" repeats binding "${binding.capability}"`);
      if (binding.value === undefined || binding.value === null) fail(`module "${mod.name}" has empty binding "${binding.capability}"`);
      bindings.set(binding.capability, binding.from);
    }
    const seenCapabilities = new Set<string>();
    for (const [optional, requirements] of [[false, mod.capabilities?.required], [true, mod.capabilities?.optional]] as const) {
      for (const requirement of requirements ?? []) {
        const key = requirement.capability;
        if (!CAPABILITY_NAME.test(key)) fail(`module "${mod.name}" requires invalid capability "${key}"`);
        if (seenCapabilities.has(key)) fail(`module "${mod.name}" repeats capability requirement "${key}"`);
        seenCapabilities.add(key);
        const target = dependency(mod, { name: requirement.from, versionRange: requirement.versionRange }, optional);
        if (target && claims.get(`capability:${key}`) !== target.name) {
          fail(`module "${mod.name}" requires capability "${key}" from "${target.name}", but it is not provided`);
        }
        if (target && bindings.get(key) !== target.name) {
          fail(`module "${mod.name}" must bind capability "${key}" from installed module "${target.name}"`);
        }
        if (!target && bindings.has(key)) fail(`module "${mod.name}" binds capability "${key}" from missing module "${requirement.from}"`);
      }
    }
    for (const key of bindings.keys()) {
      if (!seenCapabilities.has(key)) fail(`module "${mod.name}" has undeclared binding "${key}"`);
    }
    for (const { descriptor } of [...(mod.commands ?? []), ...(mod.queries ?? [])]) {
      permissions.assertKnown(descriptor.permission, `module "${mod.name}" operation "${descriptor.name}"`);
    }
    for (const policy of mod.policies ?? []) {
      for (const permission of policy.appliesTo) permissions.assertKnown(permission, `policy "${policy.id}"`);
    }
    for (const sub of mod.subscribers ?? []) {
      if (!claims.has(`event:${sub.eventName}`)) fail(`module "${mod.name}" subscribes to unknown event "${sub.eventName}"`);
      const allowedCommands = new Set<string>();
      for (const grant of sub.commands ?? []) {
        if (allowedCommands.has(grant.name)) fail(`subscriber "${mod.name}:${sub.eventName}" repeats command "${grant.name}"`);
        allowedCommands.add(grant.name);
        const owner = byName.get(grant.from);
        const target = owner?.commands?.find((entry) => entry.descriptor.name === grant.name);
        if (!target || target.descriptor.version !== grant.version) {
          fail(`subscriber "${mod.name}:${sub.eventName}" requires unknown command "${grant.from}:${grant.name}@${grant.version}"`);
        }
        if (grant.from !== mod.name && !staticTargets.some((dep) => dep.name === grant.from)
          && ![...bindings.values()].includes(grant.from)) {
          fail(`subscriber "${mod.name}:${sub.eventName}" has no dependency or binding to command owner "${grant.from}"`);
        }
      }
    }
  }

  const ordered: PlatformModule[] = [];
  const complete = new Set<string>();
  const path: string[] = [];
  function visit(mod: PlatformModule): void {
    if (complete.has(mod.name)) return;
    const cycleStart = path.indexOf(mod.name);
    if (cycleStart !== -1) fail(`module dependency cycle: ${[...path.slice(cycleStart), mod.name].join(' -> ')}`);
    path.push(mod.name);
    for (const dep of edges.get(mod.name) ?? []) visit(dep);
    path.pop();
    complete.add(mod.name);
    ordered.push(mod);
  }
  for (const mod of sorted) visit(mod);
  return Object.freeze(ordered);
}
