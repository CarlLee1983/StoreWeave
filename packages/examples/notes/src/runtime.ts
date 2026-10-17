import { BASE_ROLES, type ReleaseRoleCatalog } from '@storeweave/authorization';
import { createAuthModule } from '@storeweave/auth';
import { createSiteModule, navigationItem } from '@storeweave/site';
import type { BaseConfig } from '@storeweave/config';
import { defineRuntimeRelease } from '@storeweave/release/runtime';
import { createNotesModule } from './module';
import { notesReleaseDefinition } from './definition';
import { notesConfigProjectionFactory } from './config';
import { notesStorefrontProjectionFactory } from './storefront';

const roles: ReleaseRoleCatalog = Object.fromEntries(Object.entries(BASE_ROLES).map(([name, role]) => [name, {
  ...role,
  // Content is not installed; keep the base identity policy but only selected domain permissions.
  permissions: [...role.permissions.filter(p => !p.startsWith('content:') && !p.startsWith('contact:')),
    'notes:public-read', ...(['member', 'staff'].includes(name) ? ['notes:write'] : [])],
}]));

export const release = defineRuntimeRelease<BaseConfig>(notesReleaseDefinition, {
  config: notesConfigProjectionFactory, storefront: notesStorefrontProjectionFactory,
  roles, legacyBaselines: [],
  manifestConfig: { version: 1, store: { id: 'build-only', name: 'Build only' }, database: { url: 'postgres://manifest.invalid/unused' } },
  createModules: () => [
    createSiteModule({ ownsHomePage: true, defaultNavigation: [
      navigationItem({ menu: 'primary', label: '公開筆記', href: '/notes', position: 10 }),
      navigationItem({ menu: 'primary', label: '我的筆記', href: '/my-notes', position: 20 }),
      navigationItem({ menu: 'primary', label: '註冊', href: '/register', position: 30 }),
      navigationItem({ menu: 'primary', label: '登入', href: '/login', position: 40 }),
    ] }),
    createAuthModule({ signedInActorTypes: ['user'] }),
    createNotesModule(),
  ],
  availableExtensions: {},
});
