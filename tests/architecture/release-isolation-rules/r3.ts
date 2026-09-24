import ts from 'typescript';
import type { ProductId, Violation } from './violation';

// ---------------------------------------------------------------------------
// R3 — no product branch in common assembly (source scan)
// ---------------------------------------------------------------------------

export interface SourceText { readonly path: string; readonly text: string }
const PRODUCT_IDS = new Set<ProductId>(['commerce', 'booking']);

/**
 * Known, pinned exceptions (GitHub issue #97), matched by file + normalized (whitespace-
 * collapsed) source line + an exact expected occurrence **count** on that line — not line
 * number alone, and not "any hit on this line passes". This closes two ways a masking
 * regression could slip through the checker unnoticed: a NEW branch anywhere in scope, and
 * a duplicate of an already-exempted line added elsewhere in the same file (its count would
 * then exceed what was pinned, and the excess occurrence(s) fail); a pinned exception whose
 * snippet no longer appears (or appears fewer times than pinned) fails as stale.
 */
export interface KnownException { readonly path: string; readonly snippet: string; readonly count: number; readonly issue: string }
export const R3_KNOWN_EXCEPTIONS: readonly KnownException[] = [
  { path: 'tools/cli/src/release-validation.ts', count: 1, issue: '#97', snippet: "if (!['base', 'commerce'].includes(releaseId) || (expectedReleaseId && releaseId !== expectedReleaseId)) throw new Error('Release identity mismatch');" },
  { path: 'tools/cli/src/release-validation.ts', count: 2, issue: '#97', snippet: "const name = releaseId === 'commerce' ? 'commerce' : 'storeweave';" },
  { path: 'tools/cli/src/release-validation.ts', count: 2, issue: '#97', snippet: "return { format: 'legacy-b01' as const, releaseId: 'commerce' as const, version: '0.1.0' as const, name: 'commerce' as const };" },
  { path: 'tools/cli/src/legacy-safety-snapshot.ts', count: 1, issue: '#97', snippet: "const candidate = validateReleaseDirectory(options.candidateDirectory, 'commerce');" },
  { path: 'tools/cli/src/legacy-safety-snapshot.ts', count: 1, issue: '#97', snippet: "|| validateReleaseDirectory(candidate.directory, 'commerce').treeChecksum !== candidate.treeChecksum) throw new Error('B01 bridge artifacts changed during safety capture');" },
  { path: 'tools/cli/src/legacy-safety-snapshot.ts', count: 2, issue: '#97', snippet: "source: z.object({ format: z.literal('legacy-b01'), releaseId: z.literal('commerce'), version: z.literal('0.1.0'), name: z.literal('commerce')," },
  { path: 'tools/cli/src/legacy-safety-snapshot.ts', count: 1, issue: '#97', snippet: "if (basename(directory) !== manifest.id || manifest.candidate.releaseId !== 'commerce' || manifest.candidate.version === '0.1.0') throw new Error('Legacy safety identity mismatch');" },
  { path: 'tools/cli/src/legacy-safety-snapshot.ts', count: 1, issue: '#97', snippet: "|| catalogDigest(validateReleaseDirectory(manifest.candidate.directory, 'commerce')) !== catalogDigest(manifest.candidate)) throw new Error('Legacy safety recovery artifact changed');" },
  { path: 'tools/cli/src/legacy-paired-snapshot.ts', count: 1, issue: '#97', snippet: "|| manifest.evidence.release.releaseId !== 'commerce' || manifest.evidence.release.releaseVersion !== '0.1.0'" },
  { path: 'tools/cli/src/read-release-snapshot.ts', count: 1, issue: '#97', snippet: "const artifact = z.object({ directory: text.refine(isAbsolute), releaseId: z.enum(['base', 'commerce']), version: text," },
  { path: 'tools/cli/src/read-release-snapshot.ts', count: 1, issue: '#97', snippet: "name: z.enum(['storeweave', 'commerce']), manifestChecksum: checksum, treeChecksum: checksum }).strict();" },
  { path: 'tools/cli/src/read-release-snapshot.ts', count: 1, issue: '#97', snippet: "}).strict(), release: z.object({ sequence: decimal, checksum, releaseId: z.enum(['base', 'commerce']), releaseVersion: text, buildManifestChecksum: checksum }).strict()," },
  { path: 'tools/cli/src/storage-backup.ts', count: 1, issue: '#97', snippet: "release: z.object({ id: z.enum(['base', 'commerce']), version: z.string().min(1), buildManifestChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()," },
  { path: 'scripts/build.mjs', count: 1, issue: '#97', snippet: "const releaseId = process.env.STOREWEAVE_RELEASE ?? 'commerce';" },
  { path: 'apps/admin/vite.config.ts', count: 1, issue: '#97', snippet: "const releaseId = process.env.STOREWEAVE_RELEASE ?? 'commerce';" },
  { path: 'apps/admin/src/i18n.tsx', count: 1, issue: '#97', snippet: "navigation: '主要導覽', commerce: 'Commerce', integrations: 'Integrations', orders: '訂單', products: '商品', shipping: '配送與出貨', rmas: '退貨案件', invoices: '電子發票', erpQueue: 'ERP 佇列', systemHealth: '系統健康度', dlq: '死信佇列', online: 'Online'," },
  { path: 'apps/admin/src/i18n.tsx', count: 1, issue: '#97', snippet: "navigation: 'Main navigation', commerce: 'Commerce', integrations: 'Integrations', orders: 'Orders', products: 'Products', shipping: 'Shipping & fulfillment', rmas: 'Returns', invoices: 'Invoices', erpQueue: 'ERP queue', systemHealth: 'System health', dlq: 'Dead letter queue', online: 'Online'," },
  { path: 'apps/admin/src/i18n.tsx', count: 1, issue: '#97', snippet: "navigation: 'メインナビゲーション', commerce: 'Commerce', integrations: 'Integrations', orders: '注文', products: '商品', shipping: '配送と出荷', rmas: '返品', invoices: '電子インボイス', erpQueue: 'ERP キュー', systemHealth: 'システムヘルス', dlq: 'デッドレターキュー', online: 'オンライン'," },
];

function normalizeSnippet(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

interface Hit { readonly line: number; readonly snippet: string }

/**
 * Detected: any string literal or no-substitution template literal whose exact value is
 * `commerce`/`booking` (array/Set elements, `z.enum([...])`, `??` defaults, call arguments,
 * `case` labels, values assigned to a variable that is compared later — all of these are
 * just a matching literal node, so one rule covers them all), plus an unquoted object-literal
 * / method / accessor property **key** named exactly `commerce`/`booking`.
 *
 * NOT detected (deliberately, to keep this a cheap syntactic check rather than a partial
 * interpreter): values built from string concatenation or a template literal with a
 * substitution (`'com' + 'merce'`, `` `${a}booking` ``); computed member access through a
 * non-literal expression; an identifier merely *named* `commerce`/`booking` (an import, a
 * variable, a dotted access like `commerce.content.createArticle`) that is not itself one of
 * the two node shapes above.
 */
function collectHits(file: SourceText): Hit[] {
  const scriptKind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.(?:mjs|js|cjs)$/.test(file.path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = file.text.split('\n');
  const hits: Hit[] = [];
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const lineSnippet = (line: number) => normalizeSnippet(lines[line - 1] ?? '');
  const isProductLiteral = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PRODUCT_IDS.has(node.text as ProductId);
  const isProductKey = (node: ts.PropertyName | undefined): boolean =>
    node !== undefined && ts.isIdentifier(node) && PRODUCT_IDS.has(node.text as ProductId);

  const record = (node: ts.Node) => {
    const line = lineOf(node.getStart(source));
    hits.push({ line, snippet: lineSnippet(line) });
  };
  const visit = (node: ts.Node) => {
    if (isProductLiteral(node)) record(node);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
      || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && isProductKey(node.name)) {
      record(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function keyOf(path: string, snippet: string): string {
  return `${path}\u0000${snippet}`;
}

/** R3 — Platform/Base common assembly (incl. `tools/cli`, see R3_KNOWN_EXCEPTIONS) carries no unpinned `commerce`/`booking` literal. */
export function checkProductBranches(files: readonly SourceText[], knownExceptions: readonly KnownException[] = R3_KNOWN_EXCEPTIONS): Violation[] {
  const violations: Violation[] = [];
  const hitsByKey = new Map<string, Hit[]>();
  for (const file of files) {
    for (const hit of collectHits(file)) {
      const key = keyOf(file.path, hit.snippet);
      const existing = hitsByKey.get(key);
      if (existing) existing.push(hit); else hitsByKey.set(key, [hit]);
    }
  }

  const consumedKeys = new Set<string>();
  for (const exception of knownExceptions) {
    const key = keyOf(exception.path, normalizeSnippet(exception.snippet));
    consumedKeys.add(key);
    const hits = [...(hitsByKey.get(key) ?? [])].sort((left, right) => left.line - right.line);
    if (hits.length < exception.count) {
      violations.push({
        rule: 'R3', subject: 'common-assembly', path: exception.path,
        reason: `known exception (${exception.issue}) expected ${exception.count} occurrence(s) of its pinned snippet but found ${hits.length} — remove it or the underlying fix landed`,
      });
    }
    for (const overflow of hits.slice(exception.count)) {
      violations.push({ rule: 'R3', subject: 'common-assembly', path: `${exception.path}:${overflow.line}`, reason: `product-id literal (exceeds the ${exception.count} occurrence(s) pinned for this line by known exception ${exception.issue})` });
    }
  }
  for (const [key, hits] of hitsByKey) {
    if (consumedKeys.has(key)) continue;
    const path = key.slice(0, key.indexOf('\u0000'));
    for (const hit of hits) violations.push({ rule: 'R3', subject: 'common-assembly', path: `${path}:${hit.line}`, reason: 'product-id literal' });
  }
  return violations;
}
