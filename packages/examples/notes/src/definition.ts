import { PLATFORM_VERSION } from '@storeweave/contracts';
import { validateReleaseDefinition, type ReleaseDefinition, type ReleaseTarget } from '@storeweave/release';
import packageJson from '../package.json';

export const NOTES_TARGET_KEYS = {
  server: 'notes.server.v1',
  worker: 'notes.worker.v1',
  admin: 'notes.admin.v1',
  cli: 'notes.cli.v1',
  config: 'notes.config.v1',
  storefront: 'notes.storefront.v1',
} as const satisfies Record<ReleaseTarget, string>;

const NOTES_SELECTED = {
  modules: ['platform-site', 'platform-auth', 'notes'],
  themes: ['base'],
  extensions: [],
} as const;

/**
 * The portable Notes release identity. Executable contributions live only in
 * target subpaths so importing this root cannot load a runtime target.
 */
export const notesReleaseDefinition: ReleaseDefinition = {
  manifest: {
    id: 'notes',
    version: process.env.STOREWEAVE_RELEASE_VERSION ?? packageJson.version,
    selected: NOTES_SELECTED,
    targets: Object.fromEntries(
      (Object.keys(NOTES_TARGET_KEYS) as ReleaseTarget[]).map(target => [target, { key: NOTES_TARGET_KEYS[target] }]),
    ) as ReleaseDefinition['manifest']['targets'],
    metadata: { baseVersion: PLATFORM_VERSION },
  },
};

/** Rejects selections that would no longer be equivalent to the Notes release. */
export function validateNotesReleaseDefinition(definition: unknown): ReleaseDefinition {
  const validated = validateReleaseDefinition(definition);
  if (validated.manifest.id !== 'notes') {
    throw new NotesReleaseSelectionError('manifest.id must be "notes"');
  }
  assertExactSelection(validated.manifest.selected.modules, NOTES_SELECTED.modules, 'modules');
  assertExactSelection(validated.manifest.selected.themes, NOTES_SELECTED.themes, 'themes');
  assertExactSelection(validated.manifest.selected.extensions, NOTES_SELECTED.extensions, 'extensions');
  for (const target of Object.keys(NOTES_TARGET_KEYS) as ReleaseTarget[]) {
    if (validated.manifest.targets[target].key !== NOTES_TARGET_KEYS[target]) {
      throw new NotesReleaseSelectionError(`target "${target}" must use key "${NOTES_TARGET_KEYS[target]}"`);
    }
  }
  return validated;
}

export class NotesReleaseSelectionError extends Error {
  constructor(message: string) {
    super(`Invalid Notes release selection: ${message}`);
    this.name = 'NotesReleaseSelectionError';
  }
}

function assertExactSelection(actual: readonly string[], expected: readonly string[], name: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new NotesReleaseSelectionError(`${name} must be exactly [${expected.join(', ')}]`);
  }
}
