import { baseConfigDefinition } from '@storeweave/config';
import { resolveConfigProjection, type ConfigProjectionFactory } from '@storeweave/release/config';
import { NOTES_TARGET_KEYS, notesReleaseDefinition, validateNotesReleaseDefinition } from './definition';

export interface NotesConfigProjection {
  readonly definition: typeof baseConfigDefinition;
  readonly defaultFilename: 'notes.yaml';
}

export const notesConfigProjectionFactory: ConfigProjectionFactory<NotesConfigProjection> & { readonly source: string } = {
  target: 'config', key: NOTES_TARGET_KEYS.config, source: 'packages/examples/notes/src/config.ts',
  resolve: () => ({ definition: baseConfigDefinition, defaultFilename: 'notes.yaml' }),
};

export function resolveNotesConfigProjection(): NotesConfigProjection;
export function resolveNotesConfigProjection<Contribution>(definition: unknown, factory: ConfigProjectionFactory<Contribution>): Contribution;
export function resolveNotesConfigProjection<Contribution>(
  definition: unknown = notesReleaseDefinition,
  factory: ConfigProjectionFactory<Contribution> = notesConfigProjectionFactory as unknown as ConfigProjectionFactory<Contribution>,
): Contribution {
  return resolveConfigProjection(validateNotesReleaseDefinition(definition), factory);
}
