/** Values that can be emitted in a release build manifest. */
export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue };

/** Keys selected into a release; implementations are never stored here. */
export interface ReleaseSelection {
  readonly modules: readonly string[];
  readonly themes: readonly string[];
  readonly extensions: readonly string[];
}

/** A target-specific factory is selected by this serializable key only. */
export interface ReleaseTargetDeclaration {
  readonly key: string;
}

export type ReleaseTarget = 'server' | 'worker' | 'admin' | 'cli' | 'config' | 'storefront';

/** All executable target contributions are resolved outside this common root. */
export type ReleaseTargetDeclarations = Readonly<Record<ReleaseTarget, ReleaseTargetDeclaration>>;

/** The complete, serializable common build-manifest surface. */
export interface ReleaseManifest {
  readonly id: string;
  readonly version: string;
  readonly selected: ReleaseSelection;
  readonly targets: ReleaseTargetDeclarations;
  readonly metadata: SerializableValue;
}

/**
 * The common root is deliberately manifest-only. Consumers import a target
 * subpath to pair its declaration key with executable contributions.
 */
export interface ReleaseDefinition {
  readonly manifest: ReleaseManifest;
}

export class ReleaseDefinitionValidationError extends Error {
  constructor(message: string) {
    super(`Invalid release definition: ${message}`);
    this.name = 'ReleaseDefinitionValidationError';
  }
}

/** Validates a root that is safe to serialize and import from every artifact. */
export function validateReleaseDefinition(definition: unknown): ReleaseDefinition {
  const root = requiredRecord(definition, 'definition');
  requireOnlyKeys(root, ['manifest'], 'definition');
  return { manifest: validateManifest(root.manifest) };
}

/** Throws when a definition is invalid, while narrowing it for callers. */
export function assertReleaseDefinition(definition: unknown): asserts definition is ReleaseDefinition {
  validateReleaseDefinition(definition);
}

function validateManifest(value: unknown): ReleaseManifest {
  const manifest = requiredRecord(value, 'manifest');
  requireOnlyKeys(manifest, ['id', 'version', 'selected', 'targets', 'metadata'], 'manifest');
  return {
    id: requiredString(manifest.id, 'manifest.id'),
    version: requiredString(manifest.version, 'manifest.version'),
    selected: validateSelection(manifest.selected),
    targets: validateTargetDeclarations(manifest.targets),
    metadata: serializable(manifest.metadata, 'manifest.metadata'),
  };
}

function validateSelection(value: unknown): ReleaseSelection {
  const selection = requiredRecord(value, 'manifest.selected');
  requireOnlyKeys(selection, ['modules', 'themes', 'extensions'], 'manifest.selected');
  return {
    modules: uniqueKeys(selection.modules, 'manifest.selected.modules'),
    themes: uniqueKeys(selection.themes, 'manifest.selected.themes'),
    extensions: uniqueKeys(selection.extensions, 'manifest.selected.extensions'),
  };
}

function validateTargetDeclarations(value: unknown): ReleaseTargetDeclarations {
  const declarations = requiredRecord(value, 'manifest.targets');
  const targets: readonly ReleaseTarget[] = ['server', 'worker', 'admin', 'cli', 'config', 'storefront'];
  requireOnlyKeys(declarations, targets, 'manifest.targets');
  return Object.fromEntries(targets.map(target => {
    const declaration = requiredRecord(declarations[target], `manifest.targets.${target}`);
    requireOnlyKeys(declaration, ['key'], `manifest.targets.${target}`);
    return [target, { key: requiredString(declaration.key, `manifest.targets.${target}.key`) }];
  })) as ReleaseTargetDeclarations;
}

function uniqueKeys(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array of non-empty keys`);
  const keys = value.map((key, index) => requiredString(key, `${path}[${index}]`));
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) fail(`${path} contains duplicate selected key "${duplicate}"`);
  return keys;
}

function serializable(value: unknown, path: string, ancestors = new Set<object>()): SerializableValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    fail(`${path} must contain only serializable values; non-finite numbers are not supported`);
  }
  if (typeof value !== 'object') fail(`${path} must contain only serializable values; received ${typeof value}`);
  if (ancestors.has(value)) fail(`${path} must contain only serializable values; circular references are not supported`);
  assertJsonDataProperties(value, path, Array.isArray(value));
  if (Array.isArray(value)) {
    ancestors.add(value);
    const result = value.map((entry, index) => serializable(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainRecord(value)) fail(`${path} must contain only serializable values; received ${value.constructor?.name ?? 'object'}`);
  ancestors.add(value);
  // An own "__proto__" JSON key must remain data, not invoke Object.prototype's setter.
  const result: Record<string, SerializableValue> = Object.create(null) as Record<string, SerializableValue>;
  for (const [key, entry] of Object.entries(value)) result[key] = serializable(entry, `${path}.${key}`, ancestors);
  ancestors.delete(value);
  return result;
}

/** Reject behavior JSON.stringify could skip, invoke, or otherwise transform. */
function assertJsonDataProperties(value: object, path: string, array: boolean): void {
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) fail(`${path} must contain only serializable values; symbol properties are not supported`);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) fail(`${path}.${key} must contain only serializable values; hidden properties are not supported`);
    if (!('value' in descriptor)) fail(`${path}.${key} must contain only serializable values; accessors are not supported`);
    if (array && !arrayIndex(key)) fail(`${path}.${key} must contain only serializable values; array properties must be indexed values`);
  }
}

function arrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${path} must be a plain object`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected !== undefined) fail(`${path} may contain only ${allowed.join(', ')}; found "${unexpected}"`);
  const missing = allowed.find(key => !(key in value));
  if (missing !== undefined) fail(`${path}.${missing} is required`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new ReleaseDefinitionValidationError(message);
}
