import { notesTheme } from './theme';
import { resolveStorefrontProjection, type StorefrontProjectionFactory } from '@storeweave/release/storefront';
import { NOTES_TARGET_KEYS, notesReleaseDefinition, validateNotesReleaseDefinition } from './definition';

export interface NotesStorefrontProjection {
  readonly themes: { readonly base: typeof notesTheme };
}

export const notesStorefrontProjectionFactory: StorefrontProjectionFactory<NotesStorefrontProjection> & { readonly source: string } = {
  target: 'storefront', key: NOTES_TARGET_KEYS.storefront, source: 'packages/examples/notes/src/storefront.ts',
  resolve: () => ({ themes: { base: notesTheme } }),
};

export function resolveNotesStorefrontProjection(): NotesStorefrontProjection;
export function resolveNotesStorefrontProjection<Contribution>(definition: unknown, factory: StorefrontProjectionFactory<Contribution>): Contribution;
export function resolveNotesStorefrontProjection<Contribution>(
  definition: unknown = notesReleaseDefinition,
  factory: StorefrontProjectionFactory<Contribution> = notesStorefrontProjectionFactory as unknown as StorefrontProjectionFactory<Contribution>,
): Contribution {
  return resolveStorefrontProjection(validateNotesReleaseDefinition(definition), factory);
}
