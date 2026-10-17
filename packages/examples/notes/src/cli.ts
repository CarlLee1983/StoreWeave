import { resolveCliProjection, type CliProjectionFactory } from '@storeweave/release/cli';
import { resolveNotesConfigProjection } from './config';
import { seed } from '../../../../scripts/seeds/notes';
import { NOTES_TARGET_KEYS, notesReleaseDefinition, validateNotesReleaseDefinition } from './definition';
import { release } from './runtime';

export interface NotesCliProjection {
  readonly release: typeof release;
  readonly seed: typeof seed;
  readonly identity: {
    readonly compatibleReleaseIds: readonly ['notes'];
    readonly commandName: 'storeweave';
    readonly servicePrefix: 'storeweave-notes';
    readonly filesystemName: 'notes';
    readonly configFilename: string;
  };
  readonly commands: { readonly declared: readonly []; readonly contributions: readonly [] };
}

export const notesCliProjectionFactory: CliProjectionFactory<NotesCliProjection> = {
  target: 'cli', key: NOTES_TARGET_KEYS.cli, resolve: () => ({
    release,
    seed,
    identity: {
      compatibleReleaseIds: ['notes'],
      commandName: 'storeweave', servicePrefix: 'storeweave-notes', filesystemName: 'notes',
      configFilename: resolveNotesConfigProjection().defaultFilename,
    },
    commands: { declared: [], contributions: [] },
  }),
};

export function resolveNotesCliProjection(): NotesCliProjection;
export function resolveNotesCliProjection<Contribution>(definition: unknown, factory: CliProjectionFactory<Contribution>): Contribution;
export function resolveNotesCliProjection<Contribution>(
  definition: unknown = notesReleaseDefinition,
  factory: CliProjectionFactory<Contribution> = notesCliProjectionFactory as CliProjectionFactory<Contribution>,
): Contribution {
  return resolveCliProjection(validateNotesReleaseDefinition(definition), factory);
}

export const cliProjection = resolveNotesCliProjection();
