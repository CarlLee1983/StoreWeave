import { resolveStorefrontProjection, type StorefrontProjectionFactory } from '../../../platform/release/src/storefront';
import { FILE_REQUESTS_TARGET_KEYS, fileRequestsReleaseDefinition, validateFileRequestsReleaseDefinition } from './definition';
import type { StorefrontTheme } from '@storeweave/kernel';
import { baseTheme, editorialTheme, renderBaseLayout } from '@storeweave/theme-base';
import { createFileRequestRenderers } from '@storeweave/example-file-requests';

const themes: Readonly<Record<string, StorefrontTheme>> = {
  base: { ...baseTheme, renderers: { ...baseTheme.renderers, ...createFileRequestRenderers(renderBaseLayout) } },
  editorial: { ...editorialTheme, renderers: { ...editorialTheme.renderers, ...createFileRequestRenderers(renderBaseLayout) } },
};

export const fileRequestsStorefrontProjectionFactory: StorefrontProjectionFactory<{ readonly themes: typeof themes }> & { readonly source: string } = {
  target: 'storefront', key: FILE_REQUESTS_TARGET_KEYS.storefront, source: 'packages/examples/file-requests/src/storefront.ts',
  resolve: () => ({ themes }),
};
export function resolveFileRequestsStorefrontProjection() {
  return resolveStorefrontProjection(validateFileRequestsReleaseDefinition(fileRequestsReleaseDefinition), fileRequestsStorefrontProjectionFactory);
}
