import { normalizeGraph, type ProductId, type TargetGraph, type Violation } from './violation';

// ---------------------------------------------------------------------------
// R1 — Booking/Commerce artifact isolation (imports)
// ---------------------------------------------------------------------------

interface ProductPatterns { readonly reason: string; readonly patterns: readonly RegExp[] }

/** Floor denylist: paths that belong to a product's implementation, regardless of target. */
const PRODUCT_PATTERNS: Record<ProductId, ProductPatterns> = {
  commerce: {
    reason: 'Commerce implementation',
    patterns: [
      /(?:^|\/)packages\/commerce\//i,
      /(?:^|\/)packages\/releases\/commerce\//i,
      /(?:^|\/)packages\/themes\/default\//i,
      /(?:^|\/)apps\/api\/src\/releases\/commerce\.[cm]?[jt]sx?$/i,
      /(?:^|\/)scripts\/seeds\/commerce\.[cm]?[jt]s$/i,
      // Commerce-only host controllers/routes: not under packages/commerce/, but Commerce
      // (base.ts httpAdapter) minus Base (base.ts httpAdapter) at apps/api/src/releases/*.
      /(?:^|\/)apps\/api\/src\/controllers\/(?:analytics|catalog|inventory|cart|customer|order|promotion|coupon|shipping|callback|refund|invoice|loyalty|notification)\.controller\.[cm]?[jt]sx?$/i,
      /(?:^|\/)apps\/api\/src\/mcp\/mcp\.controller\.[cm]?[jt]sx?$/i,
      /(?:^|\/)apps\/api\/src\/storefront\/storefront\.controller\.[cm]?[jt]sx?$/i,
    ],
  },
  booking: {
    reason: 'Booking implementation',
    patterns: [
      /(?:^|\/)packages\/booking\//i,
      /(?:^|\/)packages\/releases\/booking\//i,
      /(?:^|\/)packages\/themes\/booking-default\//i,
      /(?:^|\/)apps\/api\/src\/controllers\/booking-[a-z-]+\.controller\.[cm]?[jt]sx?$/i,
      /(?:^|\/)scripts\/seeds\/booking\.[cm]?[jt]s$/i,
    ],
  },
};

/**
 * Admin (browser) pages/operations that are Commerce-specific despite living outside
 * `packages/commerce/`. Booking's Admin projection must never pull these in.
 */
export const COMMERCE_ADMIN_PAGES = [
  'apps/admin/src/pages/AnalyticsPage.tsx', 'apps/admin/src/pages/CouponsPage.tsx', 'apps/admin/src/pages/CustomersPage.tsx',
  'apps/admin/src/pages/ErpPage.tsx', 'apps/admin/src/pages/InvoicesPage.tsx', 'apps/admin/src/pages/LoyaltyPage.tsx',
  'apps/admin/src/pages/OrdersPage.tsx', 'apps/admin/src/pages/ProductsPage.tsx', 'apps/admin/src/pages/PromotionsPage.tsx',
  'apps/admin/src/pages/RmaPage.tsx', 'apps/admin/src/pages/ShippingPage.tsx',
] as const;
export const COMMERCE_ADMIN_OPERATIONS = [
  'apps/admin/src/commerce-operations.tsx', 'apps/admin/src/order-operations.ts',
  'apps/admin/src/customer-operations.ts', 'apps/admin/src/rma-operations.ts', 'apps/admin/src/shipping-operations.ts',
] as const;

function otherProduct(releaseId: TargetGraph['releaseId']): ProductId | undefined {
  return releaseId === 'booking' ? 'commerce' : releaseId === 'commerce' ? 'booking' : undefined;
}

/** R1 — a release's server/worker/cli/seed/admin graph excludes the other product's implementation. */
export function checkProductIsolation(root: string, graph: TargetGraph): Violation[] {
  const subject = `${graph.releaseId}/${graph.target}`;
  const inputs = normalizeGraph(root, graph);
  // Base excludes both products; Commerce/Booking each exclude the other one.
  const forbiddenProducts: readonly ProductId[] = graph.releaseId === 'base' ? ['commerce', 'booking']
    : (product => (product ? [product] : []))(otherProduct(graph.releaseId));

  const violations: Violation[] = [];
  for (const product of forbiddenProducts) {
    const { patterns, reason } = PRODUCT_PATTERNS[product];
    for (const input of inputs) {
      if (patterns.some(pattern => pattern.test(input))) violations.push({ rule: 'R1', subject, path: input, reason });
    }
  }
  if (graph.releaseId === 'booking' && graph.target === 'admin') {
    for (const input of inputs) {
      if ((COMMERCE_ADMIN_PAGES as readonly string[]).includes(input) || (COMMERCE_ADMIN_OPERATIONS as readonly string[]).includes(input)) {
        violations.push({ rule: 'R1', subject, path: input, reason: 'Commerce Admin page' });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// R1 — Booking clean database (tables/migrations), no DB
// ---------------------------------------------------------------------------

export interface ModulePin {
  readonly id: string;
  readonly migrationOwner: string | null;
  readonly dataRelations: readonly string[];
  readonly migrations: readonly { id: string }[];
}
export interface ReleaseManifestLike { readonly modules: readonly ModulePin[] }

const BOOKING_TABLE_PREFIX = /^(booking_|content_|platform_)/;

/**
 * Same prefix allowlist SW-139's live-database check uses (booking-clean-start.test.ts:
 * migration ids `booking-*`, `content/*`, `identity/*`, `platform[-/]*`), expressed here as
 * an intent-revealing predicate over the migration *owner* rather than a regex built by
 * string-concatenating `${owner}/x` to reuse an id-shaped pattern. Owners composing into a
 * release manifest are either exactly `content`/`identity`/`platform` (the built-in Platform
 * modules) or hyphen-prefixed (`booking-property`, `platform-cache`, …).
 */
function isBookingScopedMigrationOwner(owner: string): boolean {
  return owner === 'content' || owner === 'identity' || owner === 'platform'
    || owner.startsWith('booking-') || owner.startsWith('platform-');
}

/**
 * Static, build-time counterpart of SW-139's live-database `assertBookingOnly`: no DB
 * involved, checks the emitted manifest and declared migration SQL against the modules
 * Commerce alone owns (Commerce minus Base).
 */
export function checkBookingSchema(
  booking: ReleaseManifestLike, commerce: ReleaseManifestLike, base: ReleaseManifestLike,
  sqlRelations: readonly { readonly module: string; readonly migration: string; readonly relation: string }[] = [],
): Violation[] {
  const baseOwners = new Set(base.modules.map(module => module.id));
  const baseRelations = new Set(base.modules.flatMap(module => module.dataRelations));
  const commerceOnlyOwners = new Set(commerce.modules.map(module => module.id).filter(id => !baseOwners.has(id)));
  const commerceOnlyRelations = new Set(commerce.modules.flatMap(module => module.dataRelations).filter(relation => !baseRelations.has(relation)));
  const violations: Violation[] = [];
  const subject = 'booking/clean-database';
  for (const module of booking.modules) {
    if (module.migrationOwner) {
      if (commerceOnlyOwners.has(module.migrationOwner)) {
        violations.push({
          rule: 'R1', subject, path: `module:${module.id}`,
          reason: `migration owner "${module.migrationOwner}" is Commerce-only (${module.migrations.length} migration(s))`,
        });
      } else if (!isBookingScopedMigrationOwner(module.migrationOwner) && module.migrations.length > 0) {
        violations.push({ rule: 'R1', subject, path: `module:${module.id}`, reason: `migration owner "${module.migrationOwner}" is outside the Booking prefix allowlist` });
      }
    }
    for (const relation of module.dataRelations) {
      if (commerceOnlyRelations.has(relation)) violations.push({ rule: 'R1', subject, path: `relation:${relation}`, reason: 'Commerce-only data relation' });
      if (!BOOKING_TABLE_PREFIX.test(relation)) violations.push({ rule: 'R1', subject, path: `relation:${relation}`, reason: 'outside the Booking table-prefix allowlist' });
    }
  }
  for (const { module, migration, relation } of sqlRelations) {
    if (!BOOKING_TABLE_PREFIX.test(relation)) violations.push({ rule: 'R1', subject, path: `sql-relation:${module}/${migration}/${relation}`, reason: 'migration SQL creates a table outside the Booking table-prefix allowlist' });
    const declared = booking.modules.some(m => m.dataRelations.includes(relation));
    if (!declared) violations.push({ rule: 'R1', subject, path: `sql-relation:${module}/${migration}/${relation}`, reason: 'migration SQL creates an undeclared table' });
  }
  return violations;
}
