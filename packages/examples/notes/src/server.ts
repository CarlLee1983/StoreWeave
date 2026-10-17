import { httpAdapter } from '../../../../apps/api/src/releases/notes';
import { release } from './runtime';
import { resolveServerProjection, type ServerProjectionFactory } from '@storeweave/release/server';
import { NOTES_TARGET_KEYS, notesReleaseDefinition, validateNotesReleaseDefinition } from './definition';

export interface NotesServerProjection {
  readonly release: typeof release;
  readonly httpAdapter: typeof httpAdapter;
}

export const notesServerProjectionFactory: ServerProjectionFactory<NotesServerProjection> = {
  target: 'server',
  key: NOTES_TARGET_KEYS.server,
  resolve: () => ({ release, httpAdapter }),
};

export function resolveNotesServerProjection(): NotesServerProjection;
export function resolveNotesServerProjection<Contribution>(definition: unknown, factory: ServerProjectionFactory<Contribution>): Contribution;
export function resolveNotesServerProjection<Contribution>(
  definition: unknown = notesReleaseDefinition,
  factory: ServerProjectionFactory<Contribution> = notesServerProjectionFactory as ServerProjectionFactory<Contribution>,
): Contribution {
  return resolveServerProjection(validateNotesReleaseDefinition(definition), factory);
}

export const serverProjection = resolveNotesServerProjection();
