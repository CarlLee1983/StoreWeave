import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNoViolations, checkBookingSchema, checkProductBranches, checkProductIsolation, checkTargetIsolation,
  checkRootManifestValue, formatViolation, R3_KNOWN_EXCEPTIONS, type ReleaseManifestLike, type TargetGraph,
} from './release-isolation-rules';

const FIXTURES = resolve(__dirname, 'fixtures/sw-144');
const ROOT = resolve(__dirname, '..', '..');

function readGraph(name: string): TargetGraph {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as TargetGraph;
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
    expect(messages).toContain('[R1] booking/clean-database: module:booking-property (migration owner "order" is Commerce-only)');
    expect(messages).toContain('[R1] booking/clean-database: relation:order_orders (Commerce-only data relation)');
  });

  it('R2 — a server graph that imports React fails target isolation, named', () => {
    const violations = checkTargetIsolation(ROOT, readGraph('r2-server-react.graph.json'));
    expect(violations.map(formatViolation)).toEqual([
      '[R2] commerce/server: node_modules/react/index.js (Admin/React implementation)',
    ]);
    expect(() => assertNoViolations(violations, 'R2 target isolation')).toThrow(/\[R2\].*node_modules\/react\/index\.js/);
  });

  it('R3 — a product-id switch in common-assembly-scoped source fails, named with its line', () => {
    const path = 'tests/architecture/fixtures/sw-144/r3-product-switch.fixture.txt';
    const text = readFileSync(resolve(ROOT, path), 'utf8');
    const violations = checkProductBranches([{ path, text }], []);
    expect(violations.map(formatViolation)).toEqual([
      `[R3] common-assembly: ${path}:2 (product-id behavior branch)`,
    ]);
    expect(() => assertNoViolations(violations, 'R3 product branches')).toThrow(new RegExp(`\\[R3\\].*${path.replaceAll('/', '\\/')}:2`));
  });

  it('R3 — a stale known exception (its pinned snippet no longer present) fails loudly instead of silently passing', () => {
    const violations = checkProductBranches([], [{ path: 'tools/cli/src/release-validation.ts', snippet: "releaseId === 'no-longer-there'", issue: '#97' }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain('no longer matches its pinned snippet');
  });

  it('R3 — the real pinned #97 exception list matches its cited source exactly (guards the fixture above)', () => {
    for (const exception of R3_KNOWN_EXCEPTIONS) {
      const text = readFileSync(resolve(ROOT, exception.path), 'utf8');
      expect(text.replaceAll('\r\n', '\n')).toContain(exception.snippet);
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
