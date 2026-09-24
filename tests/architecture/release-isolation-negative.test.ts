import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoViolations, checkBookingSchema, checkProductBranches, checkProductIsolation, checkTargetIsolation,
  checkRootManifestValue, formatViolation, R3_KNOWN_EXCEPTIONS, type KnownException, type ReleaseManifestLike, type TargetGraph,
} from './release-isolation-rules';

const FIXTURES = resolve(__dirname, 'fixtures/sw-144');
const ROOT = resolve(__dirname, '..', '..');

function readGraph(name: string): TargetGraph {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as TargetGraph;
}

function readFixtureText(name: string): { path: string; text: string } {
  const path = `tests/architecture/fixtures/sw-144/${name}`;
  return { path, text: readFileSync(resolve(ROOT, path), 'utf8') };
}

/**
 * AC-004: one synthetic violation per rule, fed through the exact checker the positive
 * suite uses, asserted against its formatted `[Rn] subject: path (reason)` message.
 */
describe('SW-144 release isolation — AC-004 negative fixtures (same checker as the positive suite)', () => {
  it('R1 — a Booking worker graph that imports Commerce implementation fails, named', () => {
    const violations = checkProductIsolation(ROOT, readGraph('r1-booking-worker-commerce-import.graph.json'));
    expect(violations.map(formatViolation)).toEqual([
      '[R1] booking/worker: packages/commerce/order/src/module.ts (Commerce implementation)',
    ]);
    expect(() => assertNoViolations(violations, 'R1 product isolation')).toThrow(/\[R1\].*packages\/commerce\/order\/src\/module\.ts/);
  });

  it('R1 — a Booking module pinned to a Commerce-only migration owner fails schema isolation, named', () => {
    const fixture = JSON.parse(readFileSync(resolve(FIXTURES, 'r1-booking-commerce-table.release-manifest.json'), 'utf8')) as
      Record<'booking' | 'commerce' | 'base', ReleaseManifestLike>;
    const violations = checkBookingSchema(fixture.booking, fixture.commerce, fixture.base);
    const messages = violations.map(formatViolation);
    expect(messages).toContain('[R1] booking/clean-database: module:booking-property (migration owner "order" is Commerce-only (1 migration(s)))');
    expect(messages).toContain('[R1] booking/clean-database: relation:order_orders (Commerce-only data relation)');
  });

  it('R1 — Booking migration SQL that creates a Commerce/non-allowlisted table fails, named', () => {
    const fixture = JSON.parse(readFileSync(resolve(FIXTURES, 'r1-booking-commerce-table.release-manifest.json'), 'utf8')) as
      Record<'booking' | 'commerce' | 'base', ReleaseManifestLike>;
    const sqlRelations = JSON.parse(readFileSync(resolve(FIXTURES, 'r1-booking-migration-sql-commerce-table.sql-relations.json'), 'utf8')) as
      { module: string; migration: string; relation: string }[];
    const violations = checkBookingSchema(fixture.booking, fixture.commerce, fixture.base, sqlRelations);
    const messages = violations.map(formatViolation);
    expect(messages).toContain('[R1] booking/clean-database: sql-relation:order/0001_init/commerce_orders (migration SQL creates a table outside the Booking table-prefix allowlist)');
    expect(messages).toContain('[R1] booking/clean-database: sql-relation:order/0001_init/commerce_orders (migration SQL creates an undeclared table)');
  });

  it('R2 — a server graph that imports React fails target isolation, named', () => {
    const violations = checkTargetIsolation(ROOT, readGraph('r2-server-react.graph.json'));
    expect(violations.map(formatViolation)).toEqual([
      '[R2] commerce/server: node_modules/react/index.js (Admin/React implementation)',
    ]);
    expect(() => assertNoViolations(violations, 'R2 target isolation')).toThrow(/\[R2\].*node_modules\/react\/index\.js/);
  });

  it('R2 — a worker graph that imports an HTTP controller fails, named', () => {
    const violations = checkTargetIsolation(ROOT, readGraph('r2-worker-http-controller.graph.json'));
    expect(violations.map(formatViolation)).toEqual([
      '[R2] commerce/worker: apps/api/src/controllers/health.controller.ts (HTTP controller/server implementation)',
    ]);
  });

  it('R2 — an Admin graph that imports Nest/DB/migration/secret/provider implementation fails, each named', () => {
    const violations = checkTargetIsolation(ROOT, readGraph('r2-admin-server-implementation.graph.json'));
    const messages = violations.map(formatViolation);
    expect(messages).toEqual([
      '[R2] commerce/admin: node_modules/@nestjs/core/index.js (Nest implementation)',
      '[R2] commerce/admin: packages/platform/db/src/client.ts (database or persistence implementation)',
      '[R2] commerce/admin: packages/commerce/order/src/migrations.ts (migration implementation)',
      '[R2] commerce/admin: packages/platform/config/src/secret.ts (secret implementation)',
      '[R2] commerce/admin: packages/payment/src/providers/ecpay.ts (provider implementation)',
    ]);
  });

  it('R3 — a bare product-id string literal fails, named with its line', () => {
    const { path, text } = readFixtureText('r3-string-literal.fixture.txt');
    const violations = checkProductBranches([{ path, text }], []);
    expect(violations.map(formatViolation)).toEqual([`[R3] common-assembly: ${path}:1 (product-id literal)`]);
    expect(() => assertNoViolations(violations, 'R3 product branches')).toThrow(new RegExp(`\\[R3\\].*${path.replaceAll('/', '\\/')}:1`));
  });

  it('R3 — a switch/case label fails', () => {
    const { path, text } = readFixtureText('r3-switch-case.fixture.txt');
    expect(checkProductBranches([{ path, text }], []).map(formatViolation)).toEqual([`[R3] common-assembly: ${path}:3 (product-id literal)`]);
  });

  it('R3 — a Set membership check fails', () => {
    const { path, text } = readFixtureText('r3-set-has.fixture.txt');
    expect(checkProductBranches([{ path, text }], []).map(formatViolation)).toEqual([`[R3] common-assembly: ${path}:2 (product-id literal)`]);
  });

  it('R3 — an identifier-bound array (not just an inline literal) fails', () => {
    const { path, text } = readFixtureText('r3-identifier-bound-array.fixture.txt');
    expect(checkProductBranches([{ path, text }], []).map(formatViolation)).toEqual([`[R3] common-assembly: ${path}:1 (product-id literal)`]);
  });

  it('R3 — a `??` default fails', () => {
    const { path, text } = readFixtureText('r3-nullish-default.fixture.txt');
    expect(checkProductBranches([{ path, text }], []).map(formatViolation)).toEqual([`[R3] common-assembly: ${path}:2 (product-id literal)`]);
  });

  it('R3 — a stale known exception (its pinned snippet no longer present) fails loudly instead of silently passing', () => {
    const violations = checkProductBranches([], [{ path: 'tools/cli/src/release-validation.ts', snippet: "releaseId === 'no-longer-there'", count: 1, issue: '#97' }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain('expected 1 occurrence(s)');
    expect(violations[0]!.reason).toContain('found 0');
  });

  it('R3 — duplicating an already-exempted line elsewhere in the same file fails on the extra occurrence (exception masking regression)', () => {
    const { path, text } = readFixtureText('r3-duplicated-exception-overflow.fixture.txt');
    const exceptions: readonly KnownException[] = [{ path, snippet: "if (id === 'booking') return true;", count: 1, issue: 'test' }];
    const violations = checkProductBranches([{ path, text }], exceptions);
    expect(violations.map(formatViolation)).toEqual([
      `[R3] common-assembly: ${path}:3 (product-id literal (exceeds the 1 occurrence(s) pinned for this line by known exception test))`,
    ]);
  });

  it('R3 — the real pinned #97 exception list matches its cited source exactly, with its exact pinned count (same checker as the positive suite)', () => {
    const byPath = new Map<string, string>();
    for (const exception of R3_KNOWN_EXCEPTIONS) {
      if (!byPath.has(exception.path)) byPath.set(exception.path, readFileSync(resolve(ROOT, exception.path), 'utf8'));
    }
    const files = [...byPath].map(([path, text]) => ({ path, text }));
    // Every pinned exception's file, scanned with only the exceptions for that file: if a
    // pinned count is wrong (too high, too low, or the snippet moved), checkProductBranches
    // reports it — this does not reimplement the AST scan's counting logic in the test.
    for (const path of byPath.keys()) {
      const exceptionsForFile = R3_KNOWN_EXCEPTIONS.filter(exception => exception.path === path);
      const violations = checkProductBranches(files.filter(file => file.path === path), exceptionsForFile);
      expect(violations.map(formatViolation), path).toEqual([]);
    }
  });

  it('R4 — a root manifest with an executable metadata member fails, named with its member path', async () => {
    const { definition } = await import('./fixtures/sw-144/r4-executable-manifest.fixture');
    const violations = checkRootManifestValue(definition, 'tests/architecture/fixtures/sw-144/r4-executable-manifest.fixture.ts#definition');
    expect(violations.map(formatViolation)).toEqual([
      '[R4] root-manifest: tests/architecture/fixtures/sw-144/r4-executable-manifest.fixture.ts#definition.manifest.metadata.build (function)',
    ]);
    expect(() => assertNoViolations(violations, 'R4 root manifest')).toThrow(/\[R4\].*\.metadata\.build/);
  });
});
