import { relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * Pure checkers for SW-144 (ADR 0052 falsifier: Booking excludes Commerce implementation,
 * Platform/Base carries no product branch, target projections carry no foreign executable).
 * No I/O here except reading text/graphs the caller already collected — see
 * `release-isolation-artifacts.ts` for how real artifacts are gathered.
 */

export type Rule = 'R1' | 'R2' | 'R3' | 'R4';
export interface Violation { readonly rule: Rule; readonly subject: string; readonly path: string; readonly reason: string }
export type ReleaseId = 'base' | 'commerce' | 'booking';
export type Target = 'server' | 'worker' | 'cli' | 'seed' | 'admin' | 'root';

/** The raw shape every graph collector (real build or synthetic fixture) produces. */
export interface TargetGraph {
  readonly releaseId: ReleaseId;
  readonly target: Target;
  readonly artifact: string;
  readonly inputs: readonly string[];
}

export function formatViolation(violation: Violation): string {
  return `[${violation.rule}] ${violation.subject}: ${violation.path} (${violation.reason})`;
}

export function assertNoViolations(violations: readonly Violation[], context: string): void {
  if (violations.length === 0) return;
  throw new Error(`${context}\n${violations.map(formatViolation).join('\n')}`);
}

/** Repo-relative, `?query`/NUL stripped, `.pnpm` hop collapsed — same idea as build-projections.mjs normalizeSource. */
export function normalizePath(root: string, value: string): string {
  const stripped = value.replaceAll('\0', '').replace(/\?.*$/, '').replaceAll('\\', '/');
  const absolute = resolve(root, stripped);
  let relativePath = relative(root, absolute).replaceAll('\\', '/');
  if (relativePath.startsWith('../')) {
    const dependencyIndex = absolute.replaceAll('\\', '/').lastIndexOf('/node_modules/');
    relativePath = dependencyIndex >= 0 ? absolute.slice(dependencyIndex + 1).replaceAll('\\', '/') : stripped;
  }
  return relativePath.replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'node_modules/');
}

function normalizeGraph(root: string, graph: TargetGraph): string[] {
  return [...new Set(graph.inputs.map(input => normalizePath(root, input)))];
}

// ---------------------------------------------------------------------------
// R1 — Booking/Commerce artifact isolation (imports)
// ---------------------------------------------------------------------------

interface ProductPatterns { readonly reason: string; readonly patterns: readonly RegExp[] }

/** Floor denylist: paths that belong to a product's implementation, regardless of target. */
const PRODUCT_PATTERNS: Record<'commerce' | 'booking', ProductPatterns> = {
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

/** R1 — a release's server/worker/cli/seed/admin graph excludes the other product's implementation. */
export function checkProductIsolation(root: string, graph: TargetGraph): Violation[] {
  const forbidden: 'commerce' | 'booking' | undefined =
    graph.releaseId === 'booking' ? 'commerce' : graph.releaseId === 'commerce' ? 'booking' : undefined;
  const violations: Violation[] = [];
  const subject = `${graph.releaseId}/${graph.target}`;
  const inputs = normalizeGraph(root, graph);
  if (forbidden) {
    const { patterns, reason } = PRODUCT_PATTERNS[forbidden];
    for (const input of inputs) {
      if (patterns.some(pattern => pattern.test(input))) violations.push({ rule: 'R1', subject, path: input, reason });
    }
  } else if (graph.releaseId === 'base') {
    for (const other of ['commerce', 'booking'] as const) {
      const { patterns, reason } = PRODUCT_PATTERNS[other];
      for (const input of inputs) {
        if (patterns.some(pattern => pattern.test(input))) violations.push({ rule: 'R1', subject, path: input, reason });
      }
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
const BOOKING_MIGRATION_PREFIX = /^(booking-|content\/|identity\/|platform[/-])/;

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
    if (module.migrationOwner && commerceOnlyOwners.has(module.migrationOwner)) {
      violations.push({ rule: 'R1', subject, path: `module:${module.id}`, reason: `migration owner "${module.migrationOwner}" is Commerce-only` });
    }
    if (module.migrationOwner && !BOOKING_MIGRATION_PREFIX.test(`${module.migrationOwner}/x`) && module.migrations.length > 0) {
      violations.push({ rule: 'R1', subject, path: `module:${module.id}`, reason: `migration owner "${module.migrationOwner}" is outside the Booking prefix allowlist` });
    }
    for (const migration of module.migrations) {
      const migrationId = `${module.migrationOwner}/${migration.id}`;
      if (module.migrationOwner && commerceOnlyOwners.has(module.migrationOwner)) {
        violations.push({ rule: 'R1', subject, path: `migration:${migrationId}`, reason: 'Commerce-only migration' });
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

// ---------------------------------------------------------------------------
// R2 — target isolation
// ---------------------------------------------------------------------------

const REACT_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:react|react-dom)(?:\/|$)/i,
  /(?:^|\/)node_modules\/(?:react|react-dom)(?:\/|$)/i,
  /(?:^|\/)@tanstack\/react-query(?:\/|$)/i,
  /(?:^|\/)@vitejs\//i,
  /(?:^|\/)apps\/admin\//i,
  /(?:^|\/)packages\/releases\/[^/]+\/src\/admin\.[cm]?[jt]sx?$/i,
  /(?:^|\/)packages\/platform\/release\/src\/admin\.[cm]?[jt]sx?$/i,
  /(?:^|\/)packages\/[^/]+\/[^/]+\/src\/admin\.[cm]?[jt]sx?$/i,
];
const WORKER_HTTP_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)apps\/api\//i,
  /\.controller\.[cm]?[jt]sx?$/i,
  /(?:^|\/)@nestjs\//i,
  /(?:^|\/)node_modules\/fastify\//i,
  /(?:^|\/)@fastify\//i,
  /(?:^|\/)find-my-way(?:\/|$)/i,
  /(?:^|\/)light-my-request(?:\/|$)/i,
];
const ADMIN_FORBIDDEN_PATTERNS: readonly [RegExp, string][] = [
  [/(?:^|\/)(?:@nestjs\/[^/]+|node_modules\/@nestjs\/[^/]+)(?:\/|$)/i, 'Nest implementation'],
  [/(?:^|\/)(?:pg|drizzle-orm)(?:\/|$)/i, 'PostgreSQL or Drizzle implementation'],
  [/^node:/i, 'Node runtime'],
  [/^@storeweave\/(?:db|database)(?:\/|$)/i, 'workspace database package'],
  [/(?:^|\/)[^/]*(?:database|persistence|db)[^/]*(?:\/|$)/i, 'database or persistence implementation'],
  [/(?:^|\/)[^/]*migrations?[^/]*(?:\/|$)/i, 'migration implementation'],
  [/(?:^|\/)[^/]*secrets?[^/]*(?:\/|$)/i, 'secret implementation'],
  [/(?:^|\/)packages\/extensions(?:\/|$)/i, 'provider implementation'],
  [/(?:^|\/)packages\/(?:[^/]+\/)*src\/(?:providers?\/|(?:payment|shipping|erp|invoice)-providers?\.[cm]?[jt]sx?$|provider-(?:impl(?:ementation)?|adapter)\.[cm]?[jt]sx?$)/i, 'provider implementation'],
];
/** Known-safe ids that would otherwise match an Admin pattern above (extension-sdk client, not a provider impl). */
const ADMIN_SAFE_EXCEPTIONS: readonly RegExp[] = [/(?:^|\/)packages\/platform\/extension-sdk\/src\/providers\.ts$/];
/** HTTP client, not an HTTP server: legitimately present in every worker. */
const WORKER_HTTP_SAFE_EXCEPTIONS: readonly RegExp[] = [/(?:^|\/)packages\/platform\/extension-sdk\/src\/http\.ts$/];

/** R2 — server/worker/cli exclude React/Admin; Admin excludes Nest/DB/migrations/secrets/providers; worker excludes HTTP controllers. */
export function checkTargetIsolation(root: string, graph: TargetGraph): Violation[] {
  const subject = `${graph.releaseId}/${graph.target}`;
  const inputs = normalizeGraph(root, graph);
  const violations: Violation[] = [];
  if (graph.target === 'server' || graph.target === 'worker' || graph.target === 'cli' || graph.target === 'seed') {
    for (const input of inputs) {
      if (REACT_PATTERNS.some(pattern => pattern.test(input))) violations.push({ rule: 'R2', subject, path: input, reason: 'Admin/React implementation' });
    }
  }
  if (graph.target === 'worker') {
    for (const input of inputs) {
      if (WORKER_HTTP_SAFE_EXCEPTIONS.some(pattern => pattern.test(input))) continue;
      if (WORKER_HTTP_PATTERNS.some(pattern => pattern.test(input))) violations.push({ rule: 'R2', subject, path: input, reason: 'HTTP controller/server implementation' });
    }
  }
  if (graph.target === 'admin') {
    for (const input of inputs) {
      if (ADMIN_SAFE_EXCEPTIONS.some(pattern => pattern.test(input))) continue;
      const hit = ADMIN_FORBIDDEN_PATTERNS.find(([pattern]) => pattern.test(input));
      if (hit) violations.push({ rule: 'R2', subject, path: input, reason: hit[1] });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// R3 — no product branch in common assembly (AST scan)
// ---------------------------------------------------------------------------

export interface SourceText { readonly path: string; readonly text: string }
const BRANCH_LITERALS = new Set(['commerce', 'booking']);

/**
 * Known, pinned exceptions inside `tools/cli` (GitHub issue #97). Matched by file +
 * normalized (whitespace-collapsed) source line, not line number, so this list fails
 * loudly both when a NEW branch appears anywhere in scope and when a listed exception's
 * exact text is no longer present (the fix landed and the entry must be removed).
 */
export interface KnownException { readonly path: string; readonly snippet: string; readonly issue: string }
export const R3_KNOWN_EXCEPTIONS: readonly KnownException[] = [
  { path: 'tools/cli/src/release-validation.ts', snippet: "if (!['base', 'commerce'].includes(releaseId) || (expectedReleaseId && releaseId !== expectedReleaseId)) throw new Error('Release identity mismatch');", issue: '#97' },
  { path: 'tools/cli/src/release-validation.ts', snippet: "const name = releaseId === 'commerce' ? 'commerce' : 'storeweave';", issue: '#97' },
  { path: 'tools/cli/src/release-validation.ts', snippet: "if (releaseId === 'base' && ['admin', 'theme-assets'].some(path => existsSync(join(root, path)))) throw new Error('Base release contains Commerce assets');", issue: '#97' },
  { path: 'tools/cli/src/legacy-safety-snapshot.ts', snippet: "if (basename(directory) !== manifest.id || manifest.candidate.releaseId !== 'commerce' || manifest.candidate.version === '0.1.0') throw new Error('Legacy safety identity mismatch');", issue: '#97' },
  { path: 'tools/cli/src/legacy-paired-snapshot.ts', snippet: "|| manifest.evidence.release.releaseId !== 'commerce' || manifest.evidence.release.releaseVersion !== '0.1.0'", issue: '#97' },
];

function normalizeSnippet(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function collectBranches(file: SourceText): { line: number; snippet: string }[] {
  const scriptKind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : file.path.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind);
  const hits: { line: number; snippet: string }[] = [];
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const lineText = (line: number) => normalizeSnippet(file.text.split('\n')[line - 1] ?? '');
  const isBranchLiteral = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && BRANCH_LITERALS.has(node.text);

  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && ['===', '!==', '==', '!='].includes(node.operatorToken.getText(source))) {
      if (isBranchLiteral(node.left) || isBranchLiteral(node.right)) {
        const line = lineOf(node.getStart(source));
        hits.push({ line, snippet: lineText(line) });
      }
    }
    if (ts.isCaseClause(node) && isBranchLiteral(node.expression)) {
      const line = lineOf(node.getStart(source));
      hits.push({ line, snippet: lineText(line) });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'includes' || node.expression.name.text === 'indexOf')
      && ts.isArrayLiteralExpression(node.expression.expression)
      && node.expression.expression.elements.some(isBranchLiteral)) {
      const line = lineOf(node.getStart(source));
      hits.push({ line, snippet: lineText(line) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // De-duplicate hits on the same normalized line (a single `switch` can emit one CaseClause per line already).
  const seen = new Set<number>();
  return hits.filter(hit => (seen.has(hit.line) ? false : (seen.add(hit.line), true)));
}

/**
 * R3 — Platform/Base common assembly carries no `commerce`/`booking` behavior branch.
 *
 * Two independent passes, deliberately not coupled to one another:
 *  1. AST hits (BRANCH_LITERALS is `commerce`/`booking` only — a `=== 'base'` self-identity
 *     check, e.g. `packages/releases/base/src/definition.ts`, is not itself a product
 *     branch) are violations unless they exactly match a known exception's file+snippet.
 *  2. Every known exception's snippet must still be present, verbatim, as a full source
 *     line in its cited file — checked by plain text, not by AST classification, so a
 *     pinned exception whose branch shape the scanner does not classify (e.g. `.some()`,
 *     or a comparison against `'base'`) still fails loudly once the underlying line is
 *     edited or removed.
 */
export function checkProductBranches(files: readonly SourceText[], knownExceptions: readonly KnownException[] = R3_KNOWN_EXCEPTIONS): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const hit of collectBranches(file)) {
      const isKnown = knownExceptions.some(exception => exception.path === file.path && normalizeSnippet(exception.snippet) === hit.snippet);
      if (isKnown) continue;
      violations.push({ rule: 'R3', subject: 'common-assembly', path: `${file.path}:${hit.line}`, reason: 'product-id behavior branch' });
    }
  }
  const textByPath = new Map(files.map(file => [file.path, file.text]));
  for (const exception of knownExceptions) {
    const text = textByPath.get(exception.path);
    const lines = text ? text.split('\n').map(normalizeSnippet) : [];
    if (!lines.includes(normalizeSnippet(exception.snippet))) {
      violations.push({ rule: 'R3', subject: 'common-assembly', path: exception.path, reason: `known exception (${exception.issue}) no longer matches its pinned snippet — remove it or the underlying fix landed` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// R4 — root manifests are metadata only
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Walks a manifest value and reports anything that cannot round-trip through `JSON.stringify`. */
export function checkRootManifestValue(value: unknown, path: string): Violation[] {
  const violations: Violation[] = [];
  const visit = (node: unknown, at: string) => {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return;
    if (typeof node === 'number') { if (!Number.isFinite(node)) violations.push({ rule: 'R4', subject: 'root-manifest', path: at, reason: 'non-finite number' }); return; }
    if (typeof node === 'function') { violations.push({ rule: 'R4', subject: 'root-manifest', path: at, reason: 'function' }); return; }
    if (typeof node === 'symbol') { violations.push({ rule: 'R4', subject: 'root-manifest', path: at, reason: 'symbol' }); return; }
    if (typeof node === 'bigint') { violations.push({ rule: 'R4', subject: 'root-manifest', path: at, reason: 'bigint' }); return; }
    if (typeof node === 'undefined') { violations.push({ rule: 'R4', subject: 'root-manifest', path: at, reason: 'undefined' }); return; }
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${at}[${index}]`)); return; }
    if (isPlainObject(node)) {
      for (const key of Object.getOwnPropertyNames(node)) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
        if (descriptor.get || descriptor.set) { violations.push({ rule: 'R4', subject: 'root-manifest', path: `${at}.${key}`, reason: 'accessor property' }); continue; }
        if (!descriptor.enumerable) { violations.push({ rule: 'R4', subject: 'root-manifest', path: `${at}.${key}`, reason: 'non-enumerable property' }); continue; }
        visit(node[key], `${at}.${key}`);
      }
      for (const key of Object.getOwnPropertySymbols(node)) violations.push({ rule: 'R4', subject: 'root-manifest', path: `${at}.<symbol>`, reason: 'symbol key' });
      return;
    }
    violations.push({ rule: 'R4', subject: 'root-manifest', path: at, reason: `class instance or non-plain value (${Object.prototype.toString.call(node)})` });
  };
  visit(value, path);
  return violations;
}

const ROOT_GRAPH_ALLOWLIST: readonly RegExp[] = [
  /(?:^|\/)packages\/releases\/[^/]+\/package\.json$/i,
  /(?:^|\/)packages\/releases\/[^/]+\/src\/index\.ts$/i,
  /(?:^|\/)packages\/releases\/[^/]+\/src\/definition\.ts$/i,
  /(?:^|\/)packages\/platform\/release\/src\/index\.ts$/i,
  /(?:^|\/)packages\/platform\/release\/src\/release-definition\.ts$/i,
  /(?:^|\/)packages\/platform\/contracts\/src\//i,
];
const ROOT_GRAPH_FORBIDDEN_NODE_MODULES: readonly RegExp[] = [
  /(?:^|\/)node_modules\/(?:react|react-dom)(?:\/|$)/i,
  /(?:^|\/)node_modules\/@nestjs\//i,
  /(?:^|\/)node_modules\/pg(?:\/|$)/i,
  /(?:^|\/)node_modules\/drizzle-orm(?:\/|$)/i,
  /(?:^|\/)node_modules\/fastify(?:\/|$)/i,
];

/** R4 — importing a release root loads no target/executable code. */
export function checkRootEntryGraph(root: string, graph: TargetGraph): Violation[] {
  const subject = `${graph.releaseId}/root`;
  const violations: Violation[] = [];
  for (const input of normalizeGraph(root, graph)) {
    if (input.startsWith('node_modules/')) {
      if (ROOT_GRAPH_FORBIDDEN_NODE_MODULES.some(pattern => pattern.test(input))) violations.push({ rule: 'R4', subject, path: input, reason: 'executable-target dependency' });
      continue;
    }
    if (!ROOT_GRAPH_ALLOWLIST.some(pattern => pattern.test(input))) violations.push({ rule: 'R4', subject, path: input, reason: 'source outside the manifest-only root allowlist' });
  }
  return violations;
}
