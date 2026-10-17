import { resolveAdminProjection, type AdminProjectionFactory } from '@storeweave/release/admin';
import { NOTES_TARGET_KEYS, notesReleaseDefinition, validateNotesReleaseDefinition } from './definition';

/** Notes intentionally has no browser-admin contribution. */
export interface NotesAdminProjection { readonly enabled: false; readonly contributions: readonly [] }

export const notesAdminProjectionFactory: AdminProjectionFactory<NotesAdminProjection> = {
  target: 'admin', key: NOTES_TARGET_KEYS.admin, resolve: () => ({ enabled: false, contributions: [] }),
};

export function resolveNotesAdminProjection(): NotesAdminProjection;
export function resolveNotesAdminProjection<Contribution>(definition: unknown, factory: AdminProjectionFactory<Contribution>): Contribution;
export function resolveNotesAdminProjection<Contribution>(
  definition: unknown = notesReleaseDefinition,
  factory: AdminProjectionFactory<Contribution> = notesAdminProjectionFactory as AdminProjectionFactory<Contribution>,
): Contribution {
  return resolveAdminProjection(validateNotesReleaseDefinition(definition), factory);
}
