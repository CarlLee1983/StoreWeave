import { beforeAll, describe, expect, it } from 'vitest';
import { validateReleaseDefinition } from '../../packages/platform/release/src/release-definition';
import { baseReleaseDefinition } from '../../packages/releases/base/src/definition';
import { commerceReleaseDefinition } from '../../packages/releases/commerce/src/definition';
import { bookingReleaseDefinition } from '../../packages/releases/booking/src/definition';
// @ts-expect-error no TypeScript declaration for the build-only selector
import { releases } from '../../scripts/releases.mjs';
import {
  ROOT, buildAdminGraph, buildNodeGraphs, buildRootEntryGraph, buildSeedGraph, collectReleaseManifest,
  collectSqlRelations, commonAssemblyFiles,
} from './release-isolation-artifacts';
import {
  checkBookingSchema, checkProductBranches, checkProductIsolation, checkRootEntryGraph,
  checkRootManifestValue, checkTargetIsolation, formatViolation, normalizePath,
  type ReleaseId, type TargetGraph, type Violation,
} from './release-isolation-rules';

const RELEASE_IDS = ['base', 'commerce', 'booking'] as const;
const definitions: Record<ReleaseId, unknown> = {
  base: baseReleaseDefinition, commerce: commerceReleaseDefinition, booking: bookingReleaseDefinition,
};

let nodeGraphs: Record<ReleaseId, Record<'server' | 'worker' | 'cli', TargetGraph>>;
let seedGraphs: Record<ReleaseId, TargetGraph>;
let adminGraphs: Record<'commerce' | 'booking', TargetGraph>;
let rootGraphs: Record<ReleaseId, TargetGraph>;

beforeAll(async () => {
  const [base, commerce, booking] = await Promise.all(RELEASE_IDS.map(id => buildNodeGraphs(id)));
  nodeGraphs = { base, commerce, booking };
  const [baseSeed, commerceSeed, bookingSeed] = await Promise.all(RELEASE_IDS.map(id => buildSeedGraph(id)));
  seedGraphs = { base: baseSeed, commerce: commerceSeed, booking: bookingSeed };
  const [baseRoot, commerceRoot, bookingRoot] = await Promise.all(RELEASE_IDS.map(id => buildRootEntryGraph(id)));
  rootGraphs = { base: baseRoot, commerce: commerceRoot, booking: bookingRoot };
  // Vite reads STOREWEAVE_RELEASE from process.env at config-load time: sequential, not Promise.all.
  adminGraphs = { commerce: await buildAdminGraph('commerce'), booking: await buildAdminGraph('booking') };
}, 300_000);

function allGraphs(): TargetGraph[] {
  const graphs: TargetGraph[] = [];
  for (const id of RELEASE_IDS) {
    graphs.push(nodeGraphs[id].server, nodeGraphs[id].worker, nodeGraphs[id].cli, seedGraphs[id]);
  }
  graphs.push(adminGraphs.commerce, adminGraphs.booking);
  return graphs;
}

function expectClean(violations: Violation[]) {
  expect(violations.map(formatViolation)).toEqual([]);
}

describe('SW-144 release isolation — AC-001/002 target/product artifacts', () => {
  it('every real target graph is non-trivial and resolves its own selected source (anti-vacuity)', () => {
    for (const graph of allGraphs()) {
      expect(graph.inputs.length, `${graph.releaseId}/${graph.target} input count`).toBeGreaterThan(3);
      const selected = releases[graph.releaseId];
      const source = graph.target === 'admin' ? selected.adminProjection
        : graph.target === 'seed' ? selected.seed : selected[graph.target as 'server' | 'worker' | 'cli'];
      const normalized = graph.inputs.map(input => normalizePath(ROOT, input));
      expect(normalized, `${graph.releaseId}/${graph.target} resolves ${source}`).toContain(source);
    }
  }, 120_000);

  it('R1 — Booking and Commerce server/worker/cli/seed/admin artifacts exclude each other\'s implementation', () => {
    const violations = allGraphs().flatMap(graph => checkProductIsolation(ROOT, graph));
    expectClean(violations);
  }, 120_000);

  it('R2 — server/worker/cli exclude React/Admin; worker excludes HTTP controllers; Admin excludes server/DB/provider implementation', () => {
    const violations = allGraphs().flatMap(graph => checkTargetIsolation(ROOT, graph));
    expectClean(violations);
  }, 120_000);

  it('R1 — Booking clean database excludes Commerce-owned tables, migrations, and data relations', async () => {
    const [booking, commerce, base] = await Promise.all([
      collectReleaseManifest('booking'), collectReleaseManifest('commerce'), collectReleaseManifest('base'),
    ]);
    const sqlRelations = await collectSqlRelations('booking');
    expect(sqlRelations.length, 'Booking migration SQL creates at least one relation').toBeGreaterThan(0);
    const violations = checkBookingSchema(booking, commerce, base, sqlRelations);
    expectClean(violations);
    // Anti-vacuity: Commerce really does own modules Base does not (otherwise the check above is vacuous).
    const baseOwners = new Set(base.modules.map(m => m.id));
    expect(commerce.modules.some(m => !baseOwners.has(m.id))).toBe(true);
    // Live-database evidence stays with SW-139 (tests/integration/booking-clean-start.test.ts); this is the
    // static, build-time counterpart run without Docker/testcontainers.
  }, 60_000);
});

describe('SW-144 release isolation — AC-003 common assembly has no product branch', () => {
  it('R3 — Platform/Base assembly (incl. tools/cli, per the pinned #97 exception list) carries no commerce/booking behavior branch', () => {
    const files = commonAssemblyFiles();
    expect(files.length).toBeGreaterThan(20);
    const violations = checkProductBranches(files);
    expectClean(violations);
  });
});

describe('SW-144 release isolation — AC-002 root manifests are metadata only', () => {
  it('R4 — each release root definition is a plain-serializable manifest', () => {
    for (const id of RELEASE_IDS) {
      const definition = definitions[id];
      expect(() => validateReleaseDefinition(definition)).not.toThrow();
      expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
      const violations = checkRootManifestValue(definition, `packages/releases/${id}/src/definition.ts#${id}ReleaseDefinition`);
      expectClean(violations);
    }
  });

  it('R4 — importing a release root loads no target/executable code', () => {
    const violations = RELEASE_IDS.flatMap(id => checkRootEntryGraph(ROOT, rootGraphs[id]));
    expectClean(violations);
    for (const id of RELEASE_IDS) expect(rootGraphs[id].inputs.length).toBeGreaterThan(3);
  }, 60_000);
});
