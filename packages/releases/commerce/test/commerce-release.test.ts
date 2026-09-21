import { httpAdapter } from '../../../../apps/api/src/releases/commerce';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLATFORM_VERSION, noopLogger } from '@storeweave/contracts';
import { commerceConfigDefinition } from '@storeweave/config';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { isValidElement } from 'react';
import { release as runtimeRelease } from '../src/runtime';
import { seed } from '../../../../scripts/seeds/commerce';
import { defaultTheme, editorialTheme } from '@storeweave/theme-default';
import { describe, expect, it } from 'vitest';
import { COMMERCE_TARGET_KEYS, CommerceReleaseContributionError, CommerceReleaseSelectionError, commerceReleaseDefinition, validateCommerceReleaseDefinition } from '../src';
import { adminProjection, resolveCommerceAdminProjection } from '../src/admin';
import { resolveCommerceCliProjection } from '../src/cli';
import { resolveCommerceConfigProjection } from '../src/config';
import { resolveCommerceServerProjection } from '../src/server';
import { resolveCommerceStorefrontProjection } from '../src/storefront';
import { resolveCommerceWorkerProjection } from '../src/worker';

// Frozen from the pre-projection Commerce route table. Do not read the Admin
// shell here: it now re-exports the selected contribution under test.
const LEGACY_ADMIN_ROUTES = [
  { path: 'orders', permissions: ['order:read'], module: 'order', navLabel: 'orders', icon: 'receipt', section: 'commerce', title: 'ordersTitle', subtitle: 'ordersSubtitle', action: null, badges: [{ text: 'LIVE' }, { text: 'LIVE' }, { text: 'LIVE' }], page: 'OrdersPage' },
  { path: 'products', permissions: ['catalog:read'], module: 'catalog', navLabel: 'products', icon: 'box', section: 'commerce', title: 'productsTitle', subtitle: 'productsSubtitle', action: { label: 'createProduct', targetId: 'create-product' }, badges: null, page: 'ProductsPage' },
  { path: 'shipping', permissions: ['shipping:read'], module: 'shipping', navLabel: 'shipping', icon: 'box', section: 'commerce', title: 'shippingTitle', subtitle: 'shippingSubtitle', action: { label: 'createShippingMethod', targetId: 'create-shipping-method' }, badges: null, page: 'ShippingPage' },
  { path: 'rmas', permissions: ['rma:read'], module: 'rma', navLabel: 'rmas', icon: 'receipt', section: 'commerce', title: 'rmasTitle', subtitle: 'rmasSubtitle', action: null, badges: null, page: 'RmaPage' },
  { path: 'invoices', permissions: ['invoice:read'], module: 'invoice', navLabel: 'invoices', icon: 'receipt', section: 'commerce', title: 'invoicesTitle', subtitle: 'invoicesSubtitle', action: null, badges: null, page: 'InvoicesPage' },
  { path: 'promotions', permissions: ['promotion:read'], module: 'promotion', navLabel: 'promotions', icon: 'box', section: 'commerce', title: 'promotionsTitle', subtitle: 'promotionsSubtitle', action: { label: 'createPromotion', targetId: 'create-promotion' }, badges: null, page: 'PromotionsPage' },
  { path: 'coupons', permissions: ['coupon:read'], module: 'coupon', navLabel: 'coupons', icon: 'box', section: 'commerce', title: 'couponsTitle', subtitle: 'couponsSubtitle', action: { label: 'createCoupon', targetId: 'create-coupon' }, badges: null, page: 'CouponsPage' },
  { path: 'loyalty', permissions: ['loyalty:write'], module: 'loyalty', navLabel: 'loyaltySettings', icon: 'activity', section: 'commerce', title: 'loyaltySettingsTitle', subtitle: 'loyaltySettingsSubtitle', action: null, badges: null, page: 'LoyaltyPage' },
  { path: 'customers', permissions: ['customers:manage'], module: 'customer', navLabel: 'customers', icon: 'receipt', section: 'commerce', title: 'customersTitle', subtitle: 'customersSubtitle', action: null, badges: null, page: 'CustomersPage' },
  { path: 'brand-content', permissions: ['content:read'], module: 'content', navLabel: 'brandContent', icon: 'file-text', section: 'commerce', title: 'brandContentTitle', subtitle: 'brandContentSubtitle', action: { label: 'createArticle', targetId: 'create-article' }, badges: null, page: 'BrandContentPage' },
  { path: 'contact-inbox', permissions: ['contact:read'], module: 'content', navLabel: 'contactInbox', icon: 'send', section: 'commerce', title: 'contactInboxTitle', subtitle: 'contactInboxSubtitle', action: null, badges: null, page: 'ContactInboxPage' },
  { path: 'analytics', permissions: ['analytics:read'], module: 'order', navLabel: 'analytics', icon: 'activity', section: 'commerce', title: 'analyticsTitle', subtitle: 'analyticsSubtitle', action: null, badges: null, page: 'AnalyticsPage' },
  { path: 'notifications', permissions: ['notification:read'], module: 'notification', navLabel: 'notifications', icon: 'activity', section: 'integrations', title: 'notificationsTitle', subtitle: 'notificationsSubtitle', action: null, badges: null, page: 'NotificationsPage' },
  { path: 'erp', permissions: ['erp:read'], module: null, navLabel: 'erpQueue', icon: 'database', section: 'integrations', title: 'erpTitle', subtitle: 'erpSubtitle', action: null, badges: null, page: 'ErpPage' },
  { path: 'dlq', permissions: ['jobs:read'], module: null, navLabel: 'dlq', icon: 'alert', section: 'integrations', title: 'dlqTitle', subtitle: 'dlqSubtitle', action: null, badges: [null, { text: '2', variant: 'error' }, { text: '!', variant: 'error' }], page: 'DlqPage' },
  { path: 'system', permissions: ['jobs:read'], module: null, navLabel: 'systemHealth', icon: 'activity', section: 'integrations', title: 'systemTitle', subtitle: 'systemSubtitle', action: null, badges: null, page: 'SystemPage' },
  { path: 'media', permissions: ['media:read'], module: 'platform-media', navLabel: 'mediaLibrary', icon: 'upload', section: 'platform', title: 'mediaLibraryTitle', subtitle: 'mediaLibrarySubtitle', action: null, badges: null, page: 'MediaLibraryPage' },
  { path: 'operators', permissions: ['users:read'], module: 'platform-identity', navLabel: 'operators', icon: 'user', section: 'platform', title: 'operatorsTitle', subtitle: 'operatorsSubtitle', action: { label: 'createOperator', targetId: 'create-operator' }, badges: null, page: 'OperatorsPage' },
  { path: 'api-tokens', permissions: ['tokens:read'], module: 'platform-identity', navLabel: 'apiTokens', icon: 'shield', section: 'platform', title: 'apiTokensTitle', subtitle: 'apiTokensSubtitle', action: { label: 'issueApiToken', targetId: 'issue-api-token' }, badges: null, page: 'ApiTokensPage' },
  { path: 'inbox', permissions: ['notifications:inbox'], module: 'platform-notifications', navLabel: 'inbox', icon: 'send', section: 'platform', title: 'inboxTitle', subtitle: 'inboxSubtitle', action: null, badges: null, page: 'InboxPage' },
  { path: 'account', permissions: [], module: null, navLabel: 'account', icon: 'user', section: 'platform', title: 'accountTitle', subtitle: 'accountSubtitle', action: null, badges: null, page: 'AccountPage' },
] as const;

// Frozen from the pre-projection public-contract artifacts. The semantic
// digest excludes provenance-only source fingerprints, which change as code
// moves while the contract surfaces and executable cases remain stable.
const LEGACY_PUBLIC_CONTRACT_HASHES = {
  'docs/base/b17/b00-catalog.json': '7a6c392a4ab3bf752b5bd764d2904ac06f35832342e9c095a6406b08950d3a5e',
  'docs/base/b17/commerce-http-contract.v1.json': '1f9c5563cd8cada3c51a797a121bd3a21c17ced22329eb9e6091da8f66c7066a',
  'docs/base/b17/commerce-public-contract.structural.v1.json': '9e871b7019dc44a9da0f81d6f7bd64ffa37b20eaec0edd87281461b4536b1fb8',
} as const;
const LEGACY_SEMANTIC_CONTRACT_HASH = '9f536e6a81a0de022feb1218f298ab131ee8690ece9b01134439d0ceb4234267';
const SEMANTIC_CONTRACT_FIELDS = [
  'format', 'schemaVersion', 'scope', 'limitations', 'surfaces', 'runtimeFacets', 'cases', 'caseCount', 'caseDigest', 'remaining',
] as const;

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex');
}

function hashSemanticContract(): string {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/base/b17/commerce-public-contract.semantic.v2.json'), 'utf8')) as Record<string, unknown>;
  const compatibilityContent = Object.fromEntries(SEMANTIC_CONTRACT_FIELDS.map(field => [field, contract[field]]));
  return createHash('sha256').update(JSON.stringify(compatibilityContent)).digest('hex');
}

function commerceAdminRouteContract() {
  const context = { deadJobCount: 2, deadJobError: false };
  return adminProjection.routes.map(route => {
    const rendered = route.render(context);
    return {
      path: route.path,
      permissions: [...route.permissions],
      module: route.module ?? null,
      navLabel: route.navLabel,
      icon: route.icon,
      section: route.section,
      title: route.title,
      subtitle: route.subtitle,
      action: route.action ?? null,
      badges: route.badge ? [
        route.badge({ deadJobCount: 0, deadJobError: false }),
        route.badge(context),
        route.badge({ deadJobCount: 2, deadJobError: true }),
      ] : null,
      page: isValidElement(rendered) && typeof rendered.type === 'function' ? rendered.type.name : null,
    };
  });
}

function legacySelection() {
  const config = runtimeRelease.config.schema.parse(runtimeRelease.manifestConfig);
  return {
    modules: runtimeRelease.createModules({ config, providers: new ProviderRegistry(noopLogger) }).map(module => module.name),
    themes: Object.keys(runtimeRelease.availableThemes),
    extensions: Object.keys(runtimeRelease.availableExtensions),
  };
}

describe('Commerce release definition', () => {
  it('derives the exact Commerce identity, selection, and six target keys', () => {
    expect(commerceReleaseDefinition.manifest).toEqual({
      id: runtimeRelease.id,
      version: runtimeRelease.version,
      selected: legacySelection(),
      targets: Object.fromEntries(Object.entries(COMMERCE_TARGET_KEYS).map(([target, key]) => [target, { key }])),
      metadata: { baseVersion: PLATFORM_VERSION },
    });
  });

  it('resolves six projections to release-owned contributions', () => {
    expect(resolveCommerceServerProjection()).toEqual({ release: runtimeRelease, httpAdapter });
    expect(resolveCommerceWorkerProjection()).toEqual({ target: 'worker', release: runtimeRelease });
    expect(resolveCommerceAdminProjection()).toEqual(adminProjection);
    expect(adminProjection).toEqual({
      contributionKeys: ['commerce.admin.routes.v1'], routes: adminProjection.routes, navSections: ['commerce', 'integrations', 'platform'], defaultRoute: 'products',
    });
    expect(resolveCommerceCliProjection()).toMatchObject({
      seed,
      identity: {
        compatibleReleaseIds: ['commerce'],
        commandName: 'commerce', servicePrefix: 'commerce', filesystemName: 'commerce', legacyEnvironmentPrefix: 'COMMERCE',
        configFilename: 'commerce.yaml',
      },
      legacyB01: { releaseId: 'commerce', baselineId: 'legacy-commerce-0.1.0-pre-b02' },
      commands: { declared: ['content:backfill-legacy-media'] },
    });
    const cliCommands = resolveCommerceCliProjection().commands.contributions;
    expect(cliCommands).toHaveLength(1);
    expect(cliCommands[0]?.name).toBe('content:backfill-legacy-media');
    expect(typeof cliCommands[0]?.configure).toBe('function');
    expect(resolveCommerceConfigProjection()).toEqual({ definition: commerceConfigDefinition, defaultFilename: 'commerce.yaml' });
    expect(resolveCommerceStorefrontProjection()).toEqual({
      themes: { default: defaultTheme, editorial: editorialTheme }, themeAssets: 'packages/themes/default/assets',
    });
    expect(runtimeRelease.config).toBe(resolveCommerceConfigProjection().definition);
    expect(runtimeRelease.availableThemes).toEqual(resolveCommerceStorefrontProjection().themes);
  });

  it('preserves the complete pre-projection Commerce Admin contribution', () => {
    expect(adminProjection.navSections).toEqual(['commerce', 'integrations', 'platform']);
    expect(adminProjection.defaultRoute).toBe('products');
    expect(commerceAdminRouteContract()).toEqual(LEGACY_ADMIN_ROUTES);
  });

  it('preserves the frozen pre-projection Commerce public contracts', () => {
    for (const [path, expectedHash] of Object.entries(LEGACY_PUBLIC_CONTRACT_HASHES)) {
      expect(hashFile(path), path).toBe(expectedHash);
    }
    expect(hashSemanticContract()).toBe(LEGACY_SEMANTIC_CONTRACT_HASH);
  });

  it('preserves the fixed B01 catalog bytes', () => {
    const bytes = readFileSync(resolve(process.cwd(), 'packages/releases/commerce/src/legacy-commerce-pre-b02.json'));
    expect(bytes.byteLength).toBe(37_266);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('5d8dce601d7b3cf42c38e05a891a9941fa37df2882d045f9068bd9ba43d4b805');
  });

  it('rejects missing and duplicate server contributions before executing a target factory', () => {
    let executions = 0;
    const factory = {
      target: 'server' as const,
      key: COMMERCE_TARGET_KEYS.server,
      resolve: () => { executions += 1; return { ignored: true }; },
    };

    expect(() => resolveCommerceServerProjection(commerceReleaseDefinition, [])).toThrow(
      new CommerceReleaseContributionError('Commerce projection "server" is missing contribution key "commerce.server.v1"'),
    );
    expect(() => resolveCommerceServerProjection(commerceReleaseDefinition, [factory, factory])).toThrow(
      new CommerceReleaseContributionError('Commerce projection "server" has duplicate contribution key "commerce.server.v1"'),
    );
    expect(executions).toBe(0);
  });

  it('rejects a missing Commerce selection before executing a target factory', () => {
    const invalid = {
      manifest: {
        ...commerceReleaseDefinition.manifest,
        selected: { ...commerceReleaseDefinition.manifest.selected, modules: commerceReleaseDefinition.manifest.selected.modules.slice(1) },
      },
    };
    let executed = false;
    expect(() => resolveCommerceServerProjection(invalid, {
      target: 'server', key: COMMERCE_TARGET_KEYS.server,
      resolve: () => { executed = true; return { ignored: true }; },
    })).toThrow(new CommerceReleaseSelectionError(`modules must be exactly [${legacySelection().modules.join(', ')}]`));
    expect(executed).toBe(false);
  });

  it('rejects a different product identity before executing a target factory', () => {
    const invalid = {
      manifest: { ...commerceReleaseDefinition.manifest, id: 'booking' },
    };
    let executed = false;
    expect(() => resolveCommerceServerProjection(invalid, {
      target: 'server', key: COMMERCE_TARGET_KEYS.server,
      resolve: () => { executed = true; return { ignored: true }; },
    })).toThrow(new CommerceReleaseSelectionError('release id must be "commerce"'));
    expect(executed).toBe(false);
  });

  it('rejects duplicate Commerce selection keys before executing a target factory', () => {
    const invalid = {
      manifest: {
        ...commerceReleaseDefinition.manifest,
        selected: { ...commerceReleaseDefinition.manifest.selected, themes: ['default', 'editorial', 'default'] },
      },
    };
    let executed = false;
    expect(() => resolveCommerceServerProjection(invalid, {
      target: 'server', key: COMMERCE_TARGET_KEYS.server,
      resolve: () => { executed = true; return { ignored: true }; },
    })).toThrow('manifest.selected.themes contains duplicate selected key "default"');
    expect(executed).toBe(false);
  });

  it('rejects changed target declarations and mismatched factories', () => {
    const changedTarget = {
      manifest: {
        ...commerceReleaseDefinition.manifest,
        targets: { ...commerceReleaseDefinition.manifest.targets, admin: { key: 'commerce.admin.other' } },
      },
    };
    expect(() => validateCommerceReleaseDefinition(changedTarget)).toThrow('target "admin" must use key "commerce.admin.v1"');
    expect(() => resolveCommerceWorkerProjection(commerceReleaseDefinition, {
      target: 'worker', key: 'base.worker.v1', resolve: () => ({ ignored: true }),
    })).toThrow('Release target "worker" requires factory key "commerce.worker.v1", received "base.worker.v1"');
  });
});
