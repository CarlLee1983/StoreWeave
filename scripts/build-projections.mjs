import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const BUILD_TARGETS = [
  { target: 'server', entry: 'apps/api/src/main.ts', projectionField: 'server', artifact: 'app/api.js', alias: '@storeweave/selected-server' },
  { target: 'worker', entry: 'apps/worker/src/main.ts', projectionField: 'worker', artifact: 'app/worker.js', alias: '@storeweave/selected-worker' },
  { target: 'admin', entry: 'apps/admin/index.html', projectionField: 'adminProjection', artifact: 'admin/index.html', alias: '@storeweave/selected-admin' },
  { target: 'cli', entry: 'tools/cli/src/main.ts', projectionField: 'cli', artifact: 'app/cli.js', alias: '@storeweave/selected-cli' },
];

export const RUNTIME_PROJECTION_TARGETS = [
  { target: 'config', projectionField: 'configProjection' },
  { target: 'storefront', projectionField: 'storefrontProjection' },
];

export const ADMIN_PROJECTION_PROVENANCE = 'storeweave-projection.json';
const ADMIN_PROJECTION_FORMAT = 'storeweave.admin-projection.v1';

const RELEASE_TARGET_PROJECTION = /(?:^|\/)packages\/(?:releases\/[^/]+|examples\/file-requests)\/src\/(server|worker|admin|cli)\.[cm]?[jt]sx?$/i;
const PLATFORM_TARGET_PROJECTION = /(?:^|\/)packages\/platform\/release\/src\/(server|worker|admin|cli)\.ts$/i;
const FORBIDDEN_HOSTS = {
  server: [/^(?:apps\/admin|apps\/worker|tools\/cli)\//i, /^(?:react|react-dom)(?:\/|$)/i, /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react(?:-dom)?(?:\/|$)/i],
  worker: [/^(?:apps\/admin|apps\/api|tools\/cli)\//i, /^(?:react|react-dom)(?:\/|$)/i, /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react(?:-dom)?(?:\/|$)/i],
  admin: [/^(?:apps\/api|apps\/worker|tools\/cli)\//i],
  cli: [/^(?:apps\/admin|apps\/api|apps\/worker)\//i, /^(?:react|react-dom)(?:\/|$)/i, /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react(?:-dom)?(?:\/|$)/i],
};
const FORBIDDEN_ADMIN = [
  /(?:^|\/)(?:@nestjs\/[^/]+|node_modules\/@nestjs\/[^/]+)(?:\/|$)/i,
  /(?:^|\/)(?:pg|drizzle-orm)(?:\/|$)/i,
  /^(?:node:|@storeweave\/(?:db|database)(?:\/|$))/i,
  /(?:^|\/)[^/]*(?:database|persistence|db)[^/]*(?:\/|$)/i,
  /(?:^|\/)[^/]*migrations?(?:\/|$)/i,
  /(?:^|\/)[^/]*secrets?(?:\/|$)/i,
  /(?:^|\/)packages\/extensions(?:\/|$)/i,
  /(?:^|\/)packages\/(?:[^/]+\/)*src\/(?:providers?\/|(?:payment|shipping|erp|invoice)-providers?\.[cm]?[jt]sx?$|provider-(?:impl(?:ementation)?|adapter)\.[cm]?[jt]sx?$)/i,
];

function normalizeSource(root, value) {
  const normalized = value.replaceAll('\\', '/');
  const absolute = resolve(root, value);
  const relativePath = relative(root, absolute).replaceAll('\\', '/');
  if (!relativePath.startsWith('../')) return relativePath;
  const dependencyIndex = absolute.replaceAll('\\', '/').lastIndexOf('/node_modules/');
  return dependencyIndex >= 0 ? absolute.slice(dependencyIndex + 1).replaceAll('\\', '/') : normalized;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sortedGraphInputs(root, inputs) {
  return [...new Set(inputs.map(input => normalizeSource(root, input)))].sort();
}

function outputBytes(output) {
  if (output.type === 'chunk') return Buffer.from(output.code);
  if (typeof output.source === 'string') return Buffer.from(output.source);
  return Buffer.from(output.source);
}

function outputTree(bundle) {
  return Object.entries(bundle)
    .filter(([path]) => path !== ADMIN_PROJECTION_PROVENANCE)
    .map(([path, output]) => ({ path, sha256: sha256(outputBytes(output)) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function directoryTree(directory) {
  const files = [];
  const visit = (current, prefix = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Admin projection artifact contains a symbolic link: "${path}"`);
      if (entry.isDirectory()) visit(absolute, path);
      else if (entry.isFile()) {
        if (path !== ADMIN_PROJECTION_PROVENANCE) files.push({ path, sha256: sha256(readFileSync(absolute)) });
      }
      else throw new Error(`Admin projection artifact contains an unsupported file: "${path}"`);
    }
  };
  visit(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function createAdminProjectionProvenance({ root, releaseId, source, inputs, bundle }) {
  const normalizedInputs = sortedGraphInputs(root, inputs);
  const projection = validateProjectionGraph({
    root,
    releaseId,
    target: 'admin',
    source,
    artifact: 'admin/index.html',
    inputs: normalizedInputs,
  });
  const artifacts = outputTree(bundle);
  if (!artifacts.some(artifact => artifact.path === 'index.html')) {
    throw new Error(`Release "${releaseId}" target "admin" did not emit "index.html"`);
  }
  return {
    format: ADMIN_PROJECTION_FORMAT,
    ...projection,
    inputs: normalizedInputs,
    inputGraphChecksum: sha256(JSON.stringify(normalizedInputs)),
    artifacts,
    artifactTreeChecksum: sha256(JSON.stringify(artifacts)),
  };
}

export function validateAdminProjectionProvenance({ root, releaseId, source, directory, forbiddenSources = [] }) {
  const provenancePath = join(directory, ADMIN_PROJECTION_PROVENANCE);
  if (!existsSync(provenancePath)) {
    throw new Error(`Release "${releaseId}" target "admin" cannot reuse "${directory}": provenance is missing; rebuild Admin with "pnpm build:admin"`);
  }

  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Release "${releaseId}" target "admin" has invalid provenance at "${provenancePath}": ${detail}`);
  }
  if (provenance.format !== ADMIN_PROJECTION_FORMAT || provenance.releaseId !== releaseId || provenance.target !== 'admin' || provenance.source !== source) {
    throw new Error(`Release "${releaseId}" target "admin" cannot reuse "${directory}": provenance does not match selected source "${source}"; rebuild Admin with "pnpm build:admin"`);
  }
  if (!Array.isArray(provenance.inputs) || provenance.inputs.some(input => typeof input !== 'string')) {
    throw new Error(`Release "${releaseId}" target "admin" has invalid input graph provenance at "${provenancePath}"`);
  }

  const projection = validateProjectionGraph({
    root,
    releaseId,
    target: 'admin',
    source,
    artifact: 'admin/index.html',
    inputs: provenance.inputs,
    forbiddenSources,
  });
  if (provenance.inputCount !== projection.inputCount || provenance.inputsChecksum !== projection.inputsChecksum) {
    throw new Error(`Release "${releaseId}" target "admin" has inconsistent input graph provenance at "${provenancePath}"`);
  }
  if (provenance.inputGraphChecksum !== sha256(JSON.stringify(sortedGraphInputs(root, provenance.inputs)))) {
    throw new Error(`Release "${releaseId}" target "admin" has inconsistent normalized graph provenance at "${provenancePath}"`);
  }
  if (!Array.isArray(provenance.artifacts) || provenance.artifacts.some(artifact =>
    !artifact || typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string'
    || artifact.path.startsWith('/') || artifact.path.includes('\\') || artifact.path.split('/').some(part => part === '..' || part === ''),
  )) {
    throw new Error(`Release "${releaseId}" target "admin" has invalid artifact provenance at "${provenancePath}"`);
  }

  const artifacts = directoryTree(directory);
  if (JSON.stringify(artifacts) !== JSON.stringify(provenance.artifacts)
    || provenance.artifactTreeChecksum !== sha256(JSON.stringify(artifacts))) {
    throw new Error(`Release "${releaseId}" target "admin" artifact tree differs from its provenance at "${directory}"`);
  }
  if (!artifacts.some(artifact => artifact.path === 'index.html')) {
    throw new Error(`Release "${releaseId}" target "admin" has no "index.html" in "${directory}"`);
  }
  return projection;
}

function releaseProjectionSource(releaseId, release, spec) {
  const source = release?.[spec.projectionField];
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`Release "${releaseId}" target "${spec.target}" has no projection source for "${spec.projectionField}"`);
  }
  return source;
}

export function resolveBuildProjections({ root, releaseId, release, skipAdmin = false }) {
  if (typeof release.admin !== 'boolean') throw new Error(`Release "${releaseId}" target "admin" must declare whether its browser artifact is enabled`);
  return BUILD_TARGETS.map(spec => {
    const source = releaseProjectionSource(releaseId, release, spec);
    if (!existsSync(resolve(root, source))) {
      throw new Error(`Release "${releaseId}" target "${spec.target}" projection source is missing: "${source}"`);
    }
    if (!existsSync(resolve(root, spec.entry))) {
      throw new Error(`Release "${releaseId}" target "${spec.target}" entry source is missing: "${spec.entry}"`);
    }
    const enabled = spec.target !== 'admin' || release.admin === true;
    const status = !enabled ? 'disabled' : spec.target === 'admin' && skipAdmin ? 'skipped' : 'built';
    return { ...spec, releaseId, source, enabled, status };
  });
}

export function resolveRuntimeProjectionSources({ root, releaseId, release, runtimeProjectionSources }) {
  return RUNTIME_PROJECTION_TARGETS.map(({ target, projectionField }) => {
    const source = release?.[projectionField];
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error(`Release "${releaseId}" target "${target}" has no projection source for "${projectionField}"`);
    }
    if (!existsSync(resolve(root, source))) {
      throw new Error(`Release "${releaseId}" target "${target}" projection source is missing: "${source}"`);
    }
    const actualSource = runtimeProjectionSources?.[target];
    if (actualSource !== source) {
      throw new Error(`Release "${releaseId}" target "${target}" projection source mismatch: registry selects "${source}", runtime resolves "${actualSource ?? 'none'}"`);
    }
    return { releaseId, target, source };
  });
}

export function projectionAliases(root, releaseId, release, target) {
  const spec = BUILD_TARGETS.find(candidate => candidate.target === target);
  if (!spec) throw new Error(`Unknown build target "${target}"`);
  const source = releaseProjectionSource(releaseId, release, spec);
  return {
    '@storeweave/selected-runtime': resolve(root, release.runtime),
    [spec.alias]: resolve(root, source),
  };
}

function forbiddenReason({ target, source, input }) {
  if (target === 'admin' && FORBIDDEN_ADMIN.some(pattern => pattern.test(input))) return 'Admin browser implementation';
  if ((FORBIDDEN_HOSTS[target] ?? []).some(pattern => pattern.test(input))) return 'another executable target';
  const releaseProjection = input.match(RELEASE_TARGET_PROJECTION);
  if (releaseProjection && (releaseProjection[1]?.toLowerCase() !== target || input !== source)) return 'another release target projection';
  const platformProjection = input.match(PLATFORM_TARGET_PROJECTION);
  if (platformProjection && platformProjection[1]?.toLowerCase() !== target) return 'another target projection contract';
  return undefined;
}

export function validateProjectionGraph({ root, releaseId, target, source, artifact, inputs, forbiddenSources = [] }) {
  const normalizedSource = normalizeSource(root, source);
  const normalizedInputs = [...new Set(inputs.map(input => normalizeSource(root, input)))].sort();
  if (!normalizedInputs.includes(normalizedSource)) {
    throw new Error(`Release "${releaseId}" target "${target}" did not resolve projection source "${normalizedSource}"`);
  }

  const offending = normalizedInputs.find(input => forbiddenReason({ target, source: normalizedSource, input })
    || forbiddenSources.some(value => input === value || input.startsWith(value.endsWith('/') ? value : `${value}/`)));
  if (offending) {
    const reason = forbiddenReason({ target, source: normalizedSource, input: offending }) ?? 'release-excluded source';
    throw new Error(`Release "${releaseId}" target "${target}" imports forbidden source "${offending}" (${reason})`);
  }

  const projectInputs = normalizedInputs.filter(input => /^(?:apps|packages|scripts|tools)\//.test(input));
  return projectionMetadata({ releaseId, target, source: normalizedSource, artifact, status: 'built', inputs: projectInputs });
}

export function projectionMetadata({ releaseId, target, source, artifact, status, inputs = [] }) {
  const sortedInputs = [...new Set(inputs)].sort();
  const inputsChecksum = status === 'built'
    ? `sha256:${createHash('sha256').update(JSON.stringify(sortedInputs)).digest('hex')}`
    : null;
  return {
    releaseId,
    target,
    source,
    artifact: status === 'built' ? artifact : null,
    status,
    inputCount: sortedInputs.length,
    inputsChecksum,
  };
}

export function validateBuildGraph({ root, releaseId, target, inputs, forbiddenSources = [] }) {
  const normalizedInputs = [...new Set(inputs.map(input => normalizeSource(root, input)))].sort();
  const offending = normalizedInputs.find(input => forbiddenSources.some(value => input === value || input.startsWith(value.endsWith('/') ? value : `${value}/`)));
  if (offending) {
    throw new Error(`Release "${releaseId}" target "${target}" imports forbidden source "${offending}" (release-excluded source)`);
  }
  return normalizedInputs;
}
