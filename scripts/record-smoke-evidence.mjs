#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function fail(message) {
  throw new Error(message);
}

function usage(message) {
  fail(`${message}\nUsage: record-smoke-evidence.mjs --kind native|docker --release <id> --build-info <path> --manifest <path> --output <new path> --source-revision <value> [--artifact <file> | --artifact-name <tag> --artifact-digest sha256:<64hex>]`);
}

function parseArgs(argv) {
  const values = {};
  const names = new Set(['--kind', '--release', '--build-info', '--manifest', '--output', '--source-revision', '--artifact', '--artifact-name', '--artifact-digest']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.has(name) || value === undefined || value.startsWith('--') || Object.hasOwn(values, name)) usage(`Invalid argument: ${name ?? '(missing)'}`);
    values[name] = value;
  }
  for (const name of ['--kind', '--release', '--build-info', '--manifest', '--output', '--source-revision']) {
    if (!values[name]) usage(`Missing required argument: ${name}`);
  }
  if (!['native', 'docker'].includes(values['--kind'])) usage(`Unsupported smoke kind: ${values['--kind']}`);
  if (!['base', 'commerce'].includes(values['--release'])) usage(`Unsupported native release identity: ${values['--release']}`);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(values['--source-revision'])) {
    usage(`Source revision must be a 40- or 64-character lowercase hexadecimal object id: ${values['--source-revision']}`);
  }
  if (values['--kind'] === 'native') {
    if (!values['--artifact'] || values['--artifact-name'] || values['--artifact-digest']) usage('Native evidence requires only --artifact');
  } else if (!values['--artifact-name'] || !values['--artifact-digest'] || values['--artifact']) {
    usage('Docker evidence requires --artifact-name and --artifact-digest');
  }
  return values;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Matches catalogDigest: object fields are sorted recursively; array order is significant. */
function catalogDigest(value) {
  const canonical = JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    }
    return entry;
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function requiredString(record, field, label) {
  if (!record || typeof record !== 'object' || typeof record[field] !== 'string' || !record[field]) {
    fail(`${label} must contain a non-empty ${field}`);
  }
  return record[field];
}

function nativeArtifact(path) {
  try {
    if (!statSync(path).isFile()) fail(`Native artifact is not a file: ${path}`);
    return { name: basename(path), digest: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Native artifact')) throw error;
    fail(`Unable to read native artifact at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args['--output'])) fail(`Refusing to overwrite existing output: ${args['--output']}`);

  const buildInfo = readJson(args['--build-info'], 'build info');
  const manifest = readJson(args['--manifest'], 'release manifest');
  if (manifest?.schemaVersion !== 1) fail(`Release manifest must use schemaVersion 1, got ${String(manifest?.schemaVersion)}`);
  const releaseId = args['--release'];
  const buildReleaseId = requiredString(buildInfo, 'releaseId', 'Build info');
  const releaseVersion = requiredString(buildInfo, 'version', 'Build info');
  const buildChecksum = requiredString(buildInfo, 'manifestChecksum', 'Build info');
  const buildSourceRevision = requiredString(buildInfo, 'sourceRevision', 'Build info');
  const manifestReleaseId = requiredString(manifest, 'releaseId', 'Release manifest');
  const manifestVersion = requiredString(manifest, 'releaseVersion', 'Release manifest');
  if (buildReleaseId !== releaseId) fail(`Build info releaseId ${buildReleaseId} does not match expected release ${releaseId}`);
  if (buildSourceRevision !== args['--source-revision']) {
    fail(`Build info sourceRevision ${buildSourceRevision} does not match expected source revision ${args['--source-revision']}`);
  }
  if (manifestReleaseId !== releaseId) fail(`Release manifest releaseId ${manifestReleaseId} does not match expected release ${releaseId}`);
  if (manifestVersion !== releaseVersion) fail(`Release manifest version ${manifestVersion} does not match build info version ${releaseVersion}`);
  const manifestChecksum = catalogDigest(manifest);
  if (buildChecksum !== manifestChecksum) fail(`Build info manifestChecksum ${buildChecksum} does not match release manifest checksum ${manifestChecksum}`);

  const artifact = args['--kind'] === 'native'
    ? nativeArtifact(args['--artifact'])
    : { name: args['--artifact-name'], digest: args['--artifact-digest'] };
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) fail(`Invalid Docker artifact digest: ${artifact.digest}`);

  const evidence = {
    format: 'storeweave.release-smoke-evidence.v1',
    schemaVersion: 1,
    result: 'pass',
    kind: args['--kind'],
    sourceRevision: args['--source-revision'],
    releaseId,
    releaseVersion,
    buildInfoManifestChecksum: buildChecksum,
    manifestChecksum,
    artifact,
    completedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(args['--output'], `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    fail(`Unable to write smoke evidence to ${args['--output']}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
