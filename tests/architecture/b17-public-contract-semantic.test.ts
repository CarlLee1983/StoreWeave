import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCaseBindings,
  DEFAULT_ARTIFACT_PATH,
  executeSemanticCase,
  projectSemanticContract,
  run,
  runtimeFacets,
  semanticCaseDigest,
  semanticCases,
  semanticSurfaces,
  serializeSemanticContract,
  type SemanticContract,
} from "../../scripts/b17-public-contract-semantic";

const artifact = JSON.parse(readFileSync(DEFAULT_ARTIFACT_PATH, "utf8")) as SemanticContract;

describe("B17 Commerce public-contract semantic ledger", () => {
  it("is byte-stable and --check is read-only", () => {
    run(["--check"]);
    expect(readFileSync(DEFAULT_ARTIFACT_PATH, "utf8")).toBe(serializeSemanticContract());
  });
  it("records structural surfaces independently of semantic coverage", () => {
    const structural = JSON.parse(readFileSync(artifact.source.structural, "utf8"));
    const http = JSON.parse(readFileSync(artifact.source.http, "utf8"));
    expect(artifact.format).toBe("storeweave.commerce-public-contract.semantic.v2");
    expect(artifact.scope).toBe("composed-commerce-runtime-registry-and-http");
    expect(artifact.limitations).toContain(
      "SDK exports, runtime configuration keys and CLI commands are outside this artifact and remain governed by their package and integration tests.",
    );
    expect(artifact.surfaces).toEqual(semanticSurfaces(structural, http));
    expect(artifact.runtimeFacets).toEqual(runtimeFacets(structural, http));
    expect(artifact.remaining).toEqual([...artifact.remaining].sort());
    expect(artifact.surfaces.every(surface => surface.assurance === "provenance-only")).toBe(true);
    expect(artifact.runtimeFacets.filter(facet =>
      facet.kind === "schema-runtime"
      && ["core-job-schedule", "extension-job-schedule", "extension-event-subscription", "extension-provider"]
        .includes(artifact.surfaces.find(surface => surface.id === facet.surfaceId)!.category),
    )).toEqual([]);
  });
  it("binds every case and executes every declared runner", () => {
    const facets = new Set(artifact.runtimeFacets.map(facet => facet.id));
    const surfaces = new Set(artifact.surfaces.map(surface => surface.id));
    expect(artifact.cases).toEqual(semanticCases());
    expect(artifact.caseCount).toBe(artifact.cases.length);
    expect(artifact.caseDigest).toBe(semanticCaseDigest(artifact.cases));
    for (const sample of artifact.cases) {
      expect(surfaces.has(sample.surfaceId), sample.id).toBe(true);
      expect(sample.covers.length, sample.id).toBeGreaterThan(0);
      for (const facet of sample.covers) expect(facets.has(facet), `${sample.id}:${facet}`).toBe(true);
      expect(executeSemanticCase(sample), sample.id).toEqual(sample.expected);
    }
  });
  it("leaves every and only uncovered runtime facet in remaining", () => {
    const covered = new Set(artifact.cases.flatMap(sample => sample.covers));
    expect(artifact.remaining).toEqual(artifact.runtimeFacets.filter(facet => !covered.has(facet.id)).map(facet => facet.id));
    expect(artifact.remaining.length).toBeGreaterThan(0);
  });
  it("treats source fingerprints as provenance rather than semantic coverage", () => {
    expect(artifact.source.assurance).toBe("provenance-only");
    expect(artifact.source.limitations).toContain(
      "Only executable cases may remove runtime obligations from remaining.",
    );
    expect(artifact.sourceFiles.every(source => source.assurance === "provenance-only")).toBe(true);
    expect(artifact.semanticSources).not.toHaveLength(0);
    for (const source of artifact.semanticSources) {
      expect(source.assurance).toBe("provenance-only");
      expect(source.limitations).toContain("A source fingerprint detects drift but does not prove behavior.");
      expect(source).not.toHaveProperty("caseIds");
    }
  });
  it("exercises declared ordinary HTTP body and query fields instead of blessing empty fixtures", () => {
    const http = JSON.parse(readFileSync(artifact.source.http, "utf8"));
    const casesBySurface = new Map(artifact.cases.map(sample => [sample.surfaceId, sample]));
    for (const route of http.routes.filter((entry: any) => entry.kind === "bus" || entry.kind === "composed")) {
      if (route.request !== "body" && route.request !== "query") continue;
      const serverOwned = new Set([
        ...(route.injected ?? []),
        ...(route.serverDefaulted ?? []),
        ...Object.values(route.params ?? {}),
      ]);
      const fields = route.bodyFields
        ?? Object.keys(route.input?.properties ?? {}).filter(field => !serverOwned.has(field));
      if (!fields.length) continue;
      const sample = casesBySurface.get(`http:${route.method}:${route.path}:${route.kind}`);
      expect(sample, `${route.method} ${route.path}`).toBeDefined();
      for (const field of fields) {
        expect(Object.hasOwn(sample!.input as object, field), `${route.method} ${route.path}:${field}`).toBe(true);
      }
    }
  });
  it("fails closed when a new runtime facet has no ledger case", () => {
    const fresh = projectSemanticContract();
    const synthetic = { ...fresh, runtimeFacets: [...fresh.runtimeFacets, { id: "synthetic:unbound", surfaceId: fresh.surfaces[0]!.id, kind: "schema-runtime" as const, inputDomain: "representative" as const }] };
    const covered = new Set(synthetic.cases.flatMap(sample => sample.covers));
    expect(synthetic.runtimeFacets.filter(facet => !covered.has(facet.id)).map(facet => facet.id)).toContain("synthetic:unbound");
  });
  it("rejects a case that claims a facet owned by another surface", () => {
    const sample = artifact.cases[0]!;
    const foreign = artifact.runtimeFacets.find(facet => facet.surfaceId !== sample.surfaceId)!;
    expect(() => assertCaseBindings(
      artifact.surfaces,
      artifact.runtimeFacets,
      [{ ...sample, covers: [foreign.id] }],
    )).toThrow(/crosses/);
  });
});
