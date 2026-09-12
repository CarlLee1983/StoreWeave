import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { canonicalJson, composedCommerceModules } from "./b17-public-contract";
import { ecpayLogisticsConfig } from "../packages/extensions/ecpay-logistics/src/config";
import { ALL_MCP_TOOLS } from "../packages/extensions/mcp/src/tools";
import { busHttpInput, type BusHttpContract, type ComposedHttpContract } from "../apps/api/src/http/contract";
import { prepareMcpToolInvocation } from "../apps/api/src/mcp/invocation";

const ROOT = resolve(__dirname, "..");
export const STRUCTURAL_ARTIFACT_PATH = resolve(
  ROOT,
  "docs/base/b17/commerce-public-contract.structural.v1.json",
);
export const HTTP_ARTIFACT_PATH = resolve(
  ROOT,
  "docs/base/b17/commerce-http-contract.v1.json",
);
export const DEFAULT_ARTIFACT_PATH = resolve(
  ROOT,
  "docs/base/b17/commerce-public-contract.semantic.v2.json",
);
const SOURCE_ROOTS = [
  "apps/api/src",
  "packages/commerce",
  "packages/extensions",
  "packages/platform",
  "packages/themes",
];

type Kind = "command" | "query" | "event" | "job";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Target = {
  kind: Kind;
  name: string;
  side: "input" | "output" | "payload";
  version?: number;
};
export type SemanticCase = {
  id: string;
  runner: "schema" | "ecpay-config" | "mcp" | "http-input";
  surfaceId: string;
  behaviorId: string;
  /** Every covered runtime facet is explicit; hashes are provenance only. */
  covers: readonly string[];
  input: Json;
  context: Json;
  expected: Json;
  target?: Target;
  accepted?: Json;
  dates?: readonly string[];
  issues?: readonly { code: string; path: readonly (string | number)[] }[];
};
export type RuntimeFacet = {
  id: string;
  surfaceId: string;
  kind: "schema-runtime" | "schedule-runtime" | "event-subscription-runtime" | "provider-runtime" | "http-runtime"
    | "super-refine-branch" | "mcp-map-input" | "mcp-idempotency" | "http-input-map";
  inputDomain: "representative" | "not-input-domain-exhaustive";
};
export type SemanticSource = {
  id: string;
  file: string;
  operator: string;
  occurrences: number;
  fingerprint: string;
  assurance: "provenance-only";
  limitations: readonly string[];
};
export type SemanticSurface = {
  id: string;
  category: string;
  fingerprint: string;
  assurance: "provenance-only";
};
export type SemanticSourceFile = {
  file: string;
  fingerprint: string;
  assurance: "provenance-only";
};
export interface SemanticContract {
  format: "storeweave.commerce-public-contract.semantic.v2";
  scope: "composed-commerce-runtime-registry-and-http";
  limitations: readonly string[];
  remaining: readonly string[];
  source: {
    assurance: "provenance-only";
    limitations: readonly string[];
    structural: string;
    structuralSha256: string;
    http: string;
    httpSha256: string;
    dependencyLock: string;
    dependencyLockSha256: string;
  };
  caseDigest: string;
  caseCount: number;
  coverage: { surfaceCount: number; byCategory: Readonly<Record<string, number>> };
  surfaces: readonly SemanticSurface[];
  runtimeFacets: readonly RuntimeFacet[];
  cases: readonly SemanticCase[];
  semanticSources: readonly SemanticSource[];
  sourceFiles: readonly SemanticSourceFile[];
}

const U = "11111111-1111-4111-8111-111111111111";
const ISO = "2025-01-02T03:04:05.000Z";
// Explicit behavior probes complement the exhaustive surface/source fingerprints
// below for defaults, coercion, transforms, refinements and runtime Date values.
type CoreCase = Pick<SemanticCase, "id" | "input" | "accepted" | "dates" | "issues"> & { target: Target };
const cases: readonly CoreCase[] = [
  {
    id: "catalog.create.defaults",
    target: {
      kind: "command",
      name: "commerce.catalog.createProduct",
      side: "input",
    },
    input: { sku: "SKU-1", name: "Name", priceCents: 1 },
    accepted: {
      sku: "SKU-1",
      name: "Name",
      priceCents: 1,
      currency: "TWD",
      status: "active",
    },
  },
  {
    id: "catalog.create.strict-unknown-key",
    target: {
      kind: "command",
      name: "commerce.catalog.createProduct",
      side: "input",
    },
    input: { sku: "SKU-1", name: "Name", priceCents: 1, ignored: true },
    issues: [{ code: "unrecognized_keys", path: [] }],
  },
  {
    id: "catalog.product-output-strip",
    target: {
      kind: "query",
      name: "commerce.catalog.getProduct",
      side: "output",
    },
    input: {
      id: U,
      sku: "SKU-1",
      name: "Name",
      description: null,
      priceCents: 1,
      currency: "TWD",
      status: "active",
      createdAt: ISO,
      updatedAt: ISO,
      ignored: true,
    },
    accepted: {
      id: U,
      sku: "SKU-1",
      name: "Name",
      description: null,
      priceCents: 1,
      currency: "TWD",
      status: "active",
      createdAt: ISO,
      updatedAt: ISO,
    },
    dates: ["createdAt", "updatedAt"],
  },
  {
    id: "catalog.search.coerce-range",
    target: {
      kind: "query",
      name: "commerce.catalog.searchProducts",
      side: "input",
    },
    input: { minPriceCents: "9", maxPriceCents: "2" },
    issues: [{ code: "custom", path: ["maxPriceCents"] }],
  },
  {
    id: "inventory.adjust.default",
    target: {
      kind: "command",
      name: "commerce.inventory.adjustStock",
      side: "input",
    },
    input: { productId: U, delta: 1 },
    accepted: { productId: U, delta: 1, reason: "manual" },
  },
  {
    id: "inventory.adjust.nonzero",
    target: {
      kind: "command",
      name: "commerce.inventory.adjustStock",
      side: "input",
    },
    input: { productId: U, delta: 0 },
    issues: [{ code: "custom", path: ["delta"] }],
  },
  {
    id: "inventory.list.coerce-default",
    target: {
      kind: "query",
      name: "commerce.inventory.listStock",
      side: "input",
    },
    input: { belowQuantity: "2" },
    accepted: { belowQuantity: 2, limit: 50, offset: 0 },
  },
  {
    id: "cart.reward-redemption-zero",
    target: {
      kind: "command",
      name: "commerce.cart.setRewardRedemption",
      side: "input",
    },
    input: { amountCents: 0 },
    accepted: { amountCents: 0 },
  },
  {
    id: "cart.purge.date",
    target: {
      kind: "command",
      name: "commerce.cart.purgeStaleGuestCarts",
      side: "input",
    },
    input: { before: ISO },
    accepted: { before: ISO },
    dates: ["before"],
  },
  {
    id: "coupon.create.trim-default-date",
    target: {
      kind: "command",
      name: "commerce.coupon.createCoupon",
      side: "input",
    },
    input: { code: " AB12 ", promotionId: U, startsAt: ISO },
    accepted: {
      code: "AB12",
      promotionId: U,
      startsAt: ISO,
      perCustomerLimit: 1,
    },
    dates: ["startsAt"],
  },
  {
    id: "coupon.create.date-order",
    target: {
      kind: "command",
      name: "commerce.coupon.createCoupon",
      side: "input",
    },
    input: {
      code: "AB12",
      promotionId: U,
      startsAt: "2025-02-02T00:00:00.000Z",
      endsAt: ISO,
    },
    issues: [{ code: "custom", path: ["endsAt"] }],
  },
  {
    id: "customer.profile.address-defaults",
    target: {
      kind: "command",
      name: "commerce.customer.updateMyProfile",
      side: "input",
    },
    input: {
      address: {
        recipient: "A",
        phone: "1",
        postcode: "1",
        city: "T",
        line1: "Road",
      },
    },
    accepted: {
      address: {
        countryCode: "TW",
        recipient: "A",
        phone: "1",
        postcode: "1",
        city: "T",
        district: null,
        line1: "Road",
        line2: null,
      },
    },
  },
  {
    id: "customer.birthday-calendar",
    target: {
      kind: "command",
      name: "commerce.customer.setCustomerBirthday",
      side: "input",
    },
    input: { customerId: U, birthday: "2025-02-31", reason: " fix " },
    issues: [{ code: "custom", path: ["birthday"] }],
  },
  {
    id: "order.record-result-required",
    target: {
      kind: "command",
      name: "commerce.order.recordPaymentResult",
      side: "input",
    },
    input: { attemptRef: "a", provider: "p", status: "awaiting_payment" },
    issues: [
      { code: "custom", path: ["providerRef"] },
      { code: "custom", path: ["instructions"] },
      { code: "custom", path: ["expiresAt"] },
    ],
  },
  {
    id: "order.record-result-date",
    target: {
      kind: "command",
      name: "commerce.order.recordPaymentResult",
      side: "input",
    },
    input: {
      attemptRef: "a",
      provider: "p",
      status: "awaiting_payment",
      providerRef: "r",
      instructions: [{ label: "x", value: "y" }],
      expiresAt: ISO,
    },
    accepted: {
      attemptRef: "a",
      provider: "p",
      status: "awaiting_payment",
      providerRef: "r",
      instructions: [{ label: "x", value: "y" }],
      expiresAt: ISO,
    },
    dates: ["expiresAt"],
  },
  {
    id: "order.cancel.default",
    target: {
      kind: "command",
      name: "commerce.order.cancelOrder",
      side: "input",
    },
    input: { orderId: U },
    accepted: { orderId: U, reason: "customer request" },
  },
  {
    id: "order.get-union",
    target: { kind: "query", name: "commerce.order.getOrder", side: "input" },
    input: {},
    issues: [{ code: "custom", path: [] }],
  },
  {
    id: "order.sales.date",
    target: {
      kind: "query",
      name: "commerce.order.salesSummary",
      side: "input",
    },
    input: { from: ISO },
    accepted: { from: ISO },
    dates: ["from"],
  },
  {
    id: "promotion.create.defaults",
    target: {
      kind: "command",
      name: "commerce.promotion.createPromotion",
      side: "input",
    },
    input: {
      name: " P ",
      rule: { type: "order_percentage", percentOffBasisPoints: 100 },
    },
    accepted: {
      name: " P ",
      rule: { type: "order_percentage", percentOffBasisPoints: 100 },
      priority: 0,
      stackable: true,
      requiresCoupon: false,
      tierNames: [],
      status: "active",
    },
  },
  {
    id: "loyalty.adjust.nonzero",
    target: {
      kind: "command",
      name: "commerce.loyalty.adjustRewards",
      side: "input",
    },
    input: { customerId: U, amountCents: 0, reason: " x " },
    issues: [{ code: "custom", path: ["amountCents"] }],
  },
  {
    id: "refund.result-path",
    target: {
      kind: "command",
      name: "commerce.refund.recordRefundResult",
      side: "input",
    },
    input: {
      id: U,
      paymentProvider: "p",
      providerRequestRef: "r",
      status: "failed",
    },
    issues: [{ code: "custom", path: ["failureMessage"] }],
  },
  {
    id: "rma.discard-path",
    target: { kind: "command", name: "commerce.rma.receiveRma", side: "input" },
    input: { id: U, lines: [{ rmaLineId: U, disposition: "discard" }] },
    issues: [{ code: "custom", path: ["lines", 0, "discardReason"] }],
  },
  {
    id: "shipping.method-union",
    target: {
      kind: "query",
      name: "commerce.shipping.getShippingMethod",
      side: "input",
    },
    input: {},
    issues: [{ code: "custom", path: [] }],
  },
  {
    id: "invoice.issue-path",
    target: {
      kind: "command",
      name: "commerce.invoice.recordIssue",
      side: "input",
    },
    input: { id: U, status: "issue_failed" },
    issues: [{ code: "custom", path: ["error"] }],
  },
];

function files(root: string): string[] {
  const full = resolve(ROOT, root);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return /\.tsx?$/.test(full) ? [full] : [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(root, entry.name))
      : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [join(full, entry.name)]
        : [],
  );
}
function operator(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return;
  const text = node.expression.getText();
  if (/z\.coerce\./.test(text)) return "z.coerce";
  if (/z\.preprocess/.test(text)) return "z.preprocess";
  if (/\.(default|trim|transform|refine|superRefine|catch)$/.test(text))
    return text.slice(text.lastIndexOf(".") + 1);
  if (/\.(strict|strip|passthrough)$/.test(text))
    return `unknownKeys:${text.slice(text.lastIndexOf(".") + 1)}`;
}
export function semanticInventory(): SemanticSource[] {
  const expressions: string[] = [];
  for (const file of SOURCE_ROOTS.flatMap(files).sort()) {
    const relativeFile = relative(ROOT, file);
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      const op = operator(node);
      if (op) expressions.push(`${relativeFile}\0${op}\0${node.getText()}`);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [
    {
      id: "zod:commerce-production-source-inventory",
      file: SOURCE_ROOTS.join(" + "),
      operator: "zod-semantic-operations",
      occurrences: expressions.length,
      fingerprint: createHash("sha256")
        .update(expressions.sort().join("\n"))
        .digest("hex"),
      assurance: "provenance-only",
      limitations: [
        "A source fingerprint detects drift but does not prove behavior.",
        "Called predicate bodies and the complete input domain are not inferred from this AST inventory.",
      ],
    },
  ];
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

export function sourceFileInventory(): SemanticSourceFile[] {
  return SOURCE_ROOTS.flatMap(files).sort().map(file => ({
    file: relative(ROOT, file),
    fingerprint: createHash("sha256").update(readFileSync(file)).digest("hex"),
    assurance: "provenance-only",
  }));
}

export function semanticSurfaces(structural: any, http: any): SemanticSurface[] {
  const surfaces: SemanticSurface[] = [];
  const add = (category: string, id: string, value: unknown) => {
    surfaces.push({ id, category, fingerprint: fingerprint(value), assurance: "provenance-only" });
  };
  for (const command of structural.commands ?? []) {
    add("core-command-input", `core:command:${command.name}:input`, command.input);
    add("core-command-output", `core:command:${command.name}:output`, command.output);
  }
  for (const query of structural.queries ?? []) {
    add("core-query-input", `core:query:${query.name}:input`, query.input);
    add("core-query-output", `core:query:${query.name}:output`, query.output);
  }
  for (const event of structural.events ?? []) {
    add("core-event-payload", `core:event:${event.name}:v${event.version}`, event.payload);
  }
  for (const job of structural.jobs ?? []) {
    for (const version of job.versions ?? []) {
      add("core-job-payload", `core:job:${job.type}:v${version.version}`, version.payload);
    }
    add("core-job-schedule", `core:job:${job.type}:schedule`, job.schedule ?? {});
  }
  for (const extension of structural.extensions ?? []) {
    const extensionId = extension.manifest.id;
    add("extension-config", `extension:${extensionId}:config`, extension.manifest.configuration);
    for (const command of extension.registration.commands ?? []) {
      add("extension-command-input", `extension:${extensionId}:command:${command.name}:input`, command.input);
      add("extension-command-output", `extension:${extensionId}:command:${command.name}:output`, command.output);
    }
    for (const query of extension.registration.queries ?? []) {
      add("extension-query-input", `extension:${extensionId}:query:${query.name}:input`, query.input);
      add("extension-query-output", `extension:${extensionId}:query:${query.name}:output`, query.output);
    }
    for (const job of extension.registration.jobs ?? []) {
      for (const version of job.versions ?? []) {
        add("extension-job-payload", `extension:${extensionId}:job:${job.type}:v${version.version}`, version.payload);
      }
      add("extension-job-schedule", `extension:${extensionId}:job:${job.type}:schedule`, job.schedule ?? {});
    }
    for (const event of extension.registration.events ?? []) {
      add("extension-event-subscription", `extension:${extensionId}:event:${event.name}`, event);
    }
    for (const provider of extension.registration.providers ?? []) {
      add("extension-provider", `extension:${extensionId}:provider:${provider.kind}:${provider.id}`, provider);
    }
    for (const tool of extension.registration.mcpTools ?? []) {
      add("extension-mcp-tool", `extension:${extensionId}:mcp:${tool.name}`, tool);
    }
  }
  for (const route of http.routes ?? []) {
    const identity = `${route.kind}:${route.method}:${route.path}`;
    add("http-route", `http:${route.method}:${route.path}:${route.kind}`, route);
  }
  return surfaces.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function semanticCoverage(surfaces: readonly SemanticSurface[]): SemanticContract["coverage"] {
  const byCategory: Record<string, number> = {};
  for (const surface of surfaces) byCategory[surface.category] = (byCategory[surface.category] ?? 0) + 1;
  return { surfaceCount: surfaces.length, byCategory: Object.fromEntries(Object.entries(byCategory).sort()) };
}
function targetSurfaceId(target: Target): string {
  if (target.kind === "command" || target.kind === "query")
    return `core:${target.kind}:${target.name}:${target.side}`;
  if (target.kind === "event") return `core:event:${target.name}:v${target.version}`;
  return `core:job:${target.name}:v${target.version}`;
}
function httpSurfaceId(route: any): string {
  return `http:${route.method}:${route.path}:${route.kind}`;
}
function runtimeKind(category: string): RuntimeFacet["kind"] {
  if (category === "core-job-schedule" || category === "extension-job-schedule") return "schedule-runtime";
  if (category === "extension-event-subscription") return "event-subscription-runtime";
  if (category === "extension-provider") return "provider-runtime";
  if (category === "http-route") return "http-runtime";
  return "schema-runtime";
}

/** Runtime obligations are category-specific and independently recomputed from declared surfaces. */
export function runtimeFacets(structural: any, http: any): RuntimeFacet[] {
  const facets: RuntimeFacet[] = semanticSurfaces(structural, http).map(surface => {
    const kind = runtimeKind(surface.category);
    return {
      id: `${surface.id}:${kind}`,
      surfaceId: surface.id,
      kind,
      inputDomain: "not-input-domain-exhaustive",
    };
  });
  const ecpaySurface = "extension:ecpay-logistics:config";
  for (const branch of ["fake-timeouts", "fake-stage", "production-fake", "pickup-live", "pickup-store-required"])
    facets.push({ id: `${ecpaySurface}:super-refine:${branch}`, surfaceId: ecpaySurface, kind: "super-refine-branch", inputDomain: "not-input-domain-exhaustive" });
  for (const tool of ALL_MCP_TOOLS) {
    const surfaceId = `extension:mcp:mcp:${tool.name}`;
    facets.push({ id: `${surfaceId}:map-input`, surfaceId, kind: "mcp-map-input", inputDomain: "not-input-domain-exhaustive" });
    if (tool.target.kind === "command") facets.push({ id: `${surfaceId}:idempotency-extraction`, surfaceId, kind: "mcp-idempotency", inputDomain: "representative" });
  }
  for (const route of http.routes ?? []) if (route.kind === "bus" || route.kind === "composed") {
    const surfaceId = httpSurfaceId(route);
    facets.push({ id: `${surfaceId}:bus-http-input`, surfaceId, kind: "http-input-map", inputDomain: "not-input-domain-exhaustive" });
  }
  return facets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function expectedHttpInput(contract: any, input: any, params: Record<string, string>, serverValues: Record<string, unknown>): Json {
  const injected = contract.kind === "composed" ? contract.injected ?? [] : [];
  const allowed = [...injected, ...(contract.kind === "composed" ? contract.serverDefaulted ?? [] : [])];
  let value: any = input;
  if (contract.kind === "composed" && contract.bodyFields) value = Object.fromEntries(contract.bodyFields.map((field: string) => [field, input?.[field]]));
  if (contract.nullAsMissing && value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value };
    for (const field of contract.nullAsMissing) if (value[field] === null) value[field] = undefined;
  }
  if (contract.request === "query" && value && typeof value === "object" && !Array.isArray(value)) {
    value = { ...value };
    for (const [field, encoding] of Object.entries(contract.queryEncoding ?? {})) {
      const raw = value[field]; if (raw === undefined) continue;
      if (encoding === "csv") value[field] = raw ? raw.split(",").filter(Boolean) : undefined;
      else if (encoding === "boolean") value[field] = raw === "true" ? true : raw === "false" ? false : raw;
      else value[field] = encoding === "number-empty-default" && raw === "" ? undefined : Number(raw);
    }
  }
  if (contract.params) value = { ...(value as object), ...Object.fromEntries(Object.entries(contract.params).map(([param, field]) => [field, params[param]])) };
  return canonicalJson(allowed.length ? { ...(value as object), ...serverValues } : value);
}

function schemaExample(schema: any, field = "value"): Json {
  if (!schema || typeof schema !== "object") {
    if (/^(limit|offset)$/i.test(field)) return 1;
    return `input-${field}`;
  }
  if (schema.default !== undefined) return canonicalJson(schema.default);
  if (schema.const !== undefined) return canonicalJson(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return canonicalJson(schema.enum[0]);
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    const selected = alternatives.find((entry: any) => entry?.type !== "null") ?? alternatives[0];
    return schemaExample(selected, field);
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((entry: string) => entry !== "null")
    : schema.type;
  if (type === "object" || schema.properties) {
    return canonicalJson(Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [key, schemaExample(value, key)]),
    ));
  }
  if (type === "array" || schema.items) return [schemaExample(schema.items, field)];
  if (type === "integer" || type === "number") {
    let value = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 1);
    if (value === 0 && !/^(offset|page)$/i.test(field)) value = 1;
    if (schema.maximum !== undefined) value = Math.min(value, schema.maximum);
    return type === "integer" ? Math.ceil(value) : value;
  }
  if (type === "boolean") return true;
  if (schema.format === "uuid" || /(^|_)(id|.*Id)$/i.test(field)) return U;
  if (field === "endsAt") return "2025-01-03T03:04:05.000Z";
  if (schema.format === "date-time" || /(?:At|^from$|^to$)/.test(field)) return ISO;
  if (schema.format === "date" || schema.pattern === "^\\d{4}-\\d{2}-\\d{2}$") return "2025-01-02";
  if (schema.format === "email" || /email/i.test(field)) return "contract@example.test";
  if (schema.format === "uri" || /url/i.test(field)) return "https://example.test/value";
  let value = schema.pattern === "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    ? "value-slug"
    : schema.pattern
      ? "VALUE1"
      : `input-${field}`;
  const minimum = schema.minLength ?? 0;
  if (value.length < minimum) value = value.padEnd(minimum, "x");
  if (schema.maxLength !== undefined) value = value.slice(0, schema.maxLength);
  return value;
}

function httpCases(http: any): SemanticCase[] {
  return (http.routes ?? []).filter((route: any) => route.kind === "bus" || route.kind === "composed").map((route: any) => {
    const input: Record<string, unknown> = {};
    const serverOwned = new Set([
      ...(route.injected ?? []),
      ...(route.serverDefaulted ?? []),
      ...Object.values(route.params ?? {}),
    ]);
    const properties = Object.keys(route.input?.properties ?? {});
    const requestFields = route.bodyFields
      ?? ((route.request === "body" || route.request === "query")
        ? properties.filter(field => !serverOwned.has(field))
        : []);
    for (const field of requestFields) input[field] = schemaExample(route.input?.properties?.[field], field);
    for (const [field, encoding] of Object.entries(route.queryEncoding ?? {})) {
      const property = route.input?.properties?.[field];
      input[field] = encoding === "csv"
        ? [schemaExample(property?.items, field)].join(",")
        : encoding === "boolean"
          ? String(schemaExample(property, field))
          : String(schemaExample(property, field));
    }
    if (input.autoIssue !== undefined) input.requiresCoupon = true;
    for (const field of route.nullAsMissing ?? []) input[field] = null;
    const params = Object.fromEntries(Object.entries(route.params ?? {}).map(([param, field]) => [
      param,
      String(schemaExample(route.input?.properties?.[field as string], field as string)),
    ]));
    const serverValues = Object.fromEntries([...(route.injected ?? []), ...(route.serverDefaulted ?? [])].map((field: string) => [
      field,
      schemaExample(route.input?.properties?.[field], field),
    ]));
    const surfaceId = httpSurfaceId(route);
    return { id: `http-input:${route.method}:${route.path}`, runner: "http-input", surfaceId, behaviorId: "bus-http-input", covers: [`${surfaceId}:bus-http-input`], input: canonicalJson(input), context: canonicalJson({ params, serverValues, contract: route }), expected: expectedHttpInput(route, input, params, serverValues) };
  });
}
function mcpCases(): SemanticCase[] {
  const inputs: Record<string, Json> = {
    search_products: { query: "sku", status: "active", limit: 2 }, get_order: { orderId: U }, get_sales_summary: { from: ISO, to: ISO },
    adjust_inventory: { productId: U, delta: 1, reason: "manual", idempotencyKey: "mcp-key-123" },
  };
  const mappedInputs: Record<string, Json> = {
    search_products: { q: "sku", status: "active", limit: 2, offset: 0 },
    get_order: { id: U },
    get_sales_summary: { from: ISO, to: ISO },
    adjust_inventory: { productId: U, delta: 1, reason: "manual" },
  };
  return ALL_MCP_TOOLS.map(tool => {
    const surfaceId = `extension:mcp:mcp:${tool.name}`;
    const covers = [`${surfaceId}:map-input`]; if (tool.target.kind === "command") covers.push(`${surfaceId}:idempotency-extraction`);
    return {
      id: `mcp:${tool.name}`,
      runner: "mcp",
      surfaceId,
      behaviorId: "input-map-target-parse",
      covers,
      input: inputs[tool.name]!,
      context: canonicalJson({ target: tool.target }),
      expected: canonicalJson({
        mappedInput: mappedInputs[tool.name],
        idempotencyKey: tool.target.kind === "command" ? (inputs[tool.name] as any).idempotencyKey : null,
      }),
    };
  });
}
function ecpayCases(): SemanticCase[] {
  const entries: readonly [string, Json, string][] = [
    ["fake-timeouts", { fakeTimeoutsAfterCreate: 1 }, "fakeTimeoutsAfterCreate"], ["fake-stage", { fakeQueryStage: "arrived" }, "fakeQueryStage"],
    ["production-fake", { environment: "production", mode: "fake" }, "mode"], ["pickup-live", { pickupServiceTypes: ["pickup"], pickupStores: [{ providerStoreId: "s", storeName: "n", storeAddress: "a" }] }, "pickupStores"],
    ["pickup-store-required", { mode: "fake", pickupServiceTypes: ["pickup"] }, "pickupStores"],
  ];
  const surfaceId = "extension:ecpay-logistics:config";
  return entries.map(([branch, input, path]) => ({ id: `ecpay-config:${branch}`, runner: "ecpay-config", surfaceId, behaviorId: branch, covers: [`${surfaceId}:super-refine:${branch}`, `${surfaceId}:schema-runtime`], input, context: {}, expected: { success: false, issues: [{ code: "custom", path: [path] }] } }));
}
export function resolveSchema(target: Target): any {
  const matches: any[] = [];
  for (const module of composedCommerceModules()) {
    if (target.kind === "command")
      for (const entry of module.commands ?? [])
        if (entry.descriptor.name === target.name)
          matches.push((entry.descriptor as any)[target.side]);
    if (target.kind === "query")
      for (const entry of module.queries ?? [])
        if (entry.descriptor.name === target.name)
          matches.push((entry.descriptor as any)[target.side]);
    if (target.kind === "event")
      for (const entry of module.events ?? [])
        if (entry.name === target.name && entry.version === target.version)
          matches.push(entry.payload);
    if (target.kind === "job")
      for (const entry of module.jobs ?? [])
        if (entry.type === target.name)
          matches.push(
            entry.jobContractV1?.versions[
              target.version ?? entry.jobContractV1?.currentVersion
            ],
          );
  }
  if (
    matches.length !== 1 ||
    !matches[0] ||
    typeof matches[0].safeParse !== "function"
  )
    throw new Error(
      `Expected exactly one structural ${target.kind} target for ${target.name}`,
    );
  return matches[0];
}
export function semanticCaseDigest(
  samples: readonly SemanticCase[] = semanticCases(),
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(samples)))
    .digest("hex");
}
function assertStructuralTarget(target: Target, structural: any): void {
  const category =
    target.kind === "command"
      ? "commands"
      : target.kind === "query"
        ? "queries"
        : target.kind === "event"
          ? "events"
          : "jobs";
  const entry = structural[category]?.find(
    (candidate: any) =>
      (target.kind === "job" ? candidate.type : candidate.name) === target.name,
  );
  if (!entry)
    throw new Error(
      `Semantic target is absent from structural artifact: ${target.kind} ${target.name}`,
    );
  if (target.kind === "command" || target.kind === "query") {
    if (target.side !== "input" && target.side !== "output")
      throw new Error(`Invalid structural side for ${target.name}`);
    return;
  }
  if (
    target.kind === "event" &&
    (target.side !== "payload" || entry.version !== target.version)
  )
    throw new Error(
      `Semantic event target/version is absent from structural artifact: ${target.name}`,
    );
  if (
    target.kind === "job" &&
    (target.side !== "payload" ||
      !entry.versions.some(
        (version: any) => version.version === target.version,
      ))
  )
    throw new Error(
      `Semantic job target/version is absent from structural artifact: ${target.name}`,
    );
}
export function projectSemanticContract(): SemanticContract {
  const structuralBytes = readFileSync(STRUCTURAL_ARTIFACT_PATH);
  const structural = JSON.parse(structuralBytes.toString("utf8"));
  const httpBytes = readFileSync(HTTP_ARTIFACT_PATH);
  const http = JSON.parse(httpBytes.toString("utf8"));
  const dependencyLockPath = resolve(ROOT, "pnpm-lock.yaml");
  const dependencyLockBytes = readFileSync(dependencyLockPath);
  for (const sample of cases) assertStructuralTarget(sample.target, structural);
  const surfaces = semanticSurfaces(structural, http);
  const runtime = runtimeFacets(structural, http);
  const executableCases = semanticCases();
  assertCaseBindings(surfaces, runtime, executableCases);
  const covered = new Set(executableCases.flatMap(sample => sample.covers));
  return canonicalJson({
    format: "storeweave.commerce-public-contract.semantic.v2",
    scope: "composed-commerce-runtime-registry-and-http",
    limitations: [
      "This ledger inventories the composed Commerce command, query, event, job, extension registration and HTTP route catalogs.",
      "SDK exports, runtime configuration keys and CLI commands are outside this artifact and remain governed by their package and integration tests.",
      "Representative cases do not enumerate arbitrary predicate or callback input domains.",
    ],
    remaining: runtime.filter(facet => !covered.has(facet.id)).map(facet => facet.id),
    source: {
      assurance: "provenance-only",
      limitations: [
        "Artifact, dependency and source hashes detect drift but do not prove behavior.",
        "Only executable cases may remove runtime obligations from remaining.",
      ],
      structural: "docs/base/b17/commerce-public-contract.structural.v1.json",
      structuralSha256: createHash("sha256")
        .update(structuralBytes)
        .digest("hex"),
      http: "docs/base/b17/commerce-http-contract.v1.json",
      httpSha256: createHash("sha256").update(httpBytes).digest("hex"),
      dependencyLock: "pnpm-lock.yaml",
      dependencyLockSha256: createHash("sha256").update(dependencyLockBytes).digest("hex"),
    },
    caseCount: executableCases.length,
    caseDigest: semanticCaseDigest(executableCases),
    coverage: semanticCoverage(surfaces),
    surfaces,
    runtimeFacets: runtime,
    cases: executableCases,
    semanticSources: semanticInventory(),
    sourceFiles: sourceFileInventory(),
  }) as unknown as SemanticContract;
}
export function semanticCases(): readonly SemanticCase[] {
  const core = cases.map(sample => {
    const surfaceId = targetSurfaceId(sample.target);
    const expected = canonicalJson(sample.accepted !== undefined ? { success: true, data: sample.accepted } : { success: false, issues: sample.issues ?? [] });
    return { ...sample, runner: "schema" as const, surfaceId, behaviorId: "zod-behavior", covers: [`${surfaceId}:schema-runtime`], context: {}, expected };
  });
  return [...core, ...ecpayCases(), ...mcpCases(), ...httpCases(JSON.parse(readFileSync(HTTP_ARTIFACT_PATH, "utf8")))].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function executeSemanticCase(sample: SemanticCase): Json {
  if (sample.runner === "schema") {
    const parsed = resolveSchema(sample.target!).safeParse(sample.input);
    return parsed.success ? canonicalJson({ success: true, data: normalizedJson(parsed.data) }) : canonicalJson({ success: false, issues: parsed.error.issues.map((issue: any) => ({ code: issue.code, path: issue.path })) });
  }
  if (sample.runner === "ecpay-config") {
    const parsed = ecpayLogisticsConfig.safeParse(sample.input);
    return parsed.success ? canonicalJson({ success: true, data: parsed.data }) : canonicalJson({ success: false, issues: parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })) });
  }
  if (sample.runner === "mcp") {
    const tool = ALL_MCP_TOOLS.find(entry => entry.name === sample.id.slice("mcp:".length));
    if (!tool) throw new Error(`Unknown MCP case ${sample.id}`);
    const invocation = prepareMcpToolInvocation(tool, sample.input);
    const mapped = invocation.input;
    const target = resolveSchema({ kind: tool.target.kind, name: tool.target.name, side: "input" });
    if (!target.safeParse(mapped).success) throw new Error(`MCP case ${sample.id} did not map to a valid target input`);
    const idempotencyKey = invocation.idempotencyKey ?? null;
    return canonicalJson({ mappedInput: mapped, idempotencyKey });
  }
  const context = sample.context as any;
  const contract = context.contract as BusHttpContract | ComposedHttpContract;
  const mapped = busHttpInput(contract, sample.input, context.params, context.serverValues);
  const target = resolveSchema({ kind: contract.target.kind, name: contract.target.name, side: "input" });
  const parsed = target.safeParse(mapped);
  if (!parsed.success) {
    throw new Error(`HTTP case ${sample.id} did not map to a valid target input: ${JSON.stringify(parsed.error.issues)}`);
  }
  return canonicalJson(mapped);
}

export function assertCaseBindings(
  surfaces: readonly SemanticSurface[],
  facets: readonly RuntimeFacet[],
  samples: readonly SemanticCase[],
): void {
  const surfaceIds = new Set(surfaces.map(surface => surface.id));
  const facetsById = new Map(facets.map(facet => [facet.id, facet]));
  for (const sample of samples) {
    if (!surfaceIds.has(sample.surfaceId)) throw new Error(`Case ${sample.id} has an unknown surface`);
    for (const facetId of sample.covers) {
      const facet = facetsById.get(facetId);
      if (!facet) throw new Error(`Case ${sample.id} covers an unknown runtime facet ${facetId}`);
      if (facet.surfaceId !== sample.surfaceId) {
        throw new Error(`Case ${sample.id} crosses from ${sample.surfaceId} to ${facet.surfaceId}`);
      }
    }
  }
}
function normalizedJson(value: any): Json {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizedJson(item)]));
  return value;
}
export function serializeSemanticContract(): string {
  return `${JSON.stringify(projectSemanticContract(), null, 2)}\n`;
}
export function run(argv: readonly string[]): void {
  const output = serializeSemanticContract();
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) {
    if (
      !existsSync(DEFAULT_ARTIFACT_PATH) ||
      readFileSync(DEFAULT_ARTIFACT_PATH, "utf8") !== output
    )
      throw new Error(
        "Checked-in semantic contract differs; generate a candidate with --output <new path> and review it.",
      );
    return;
  }
  if (argv.length !== 2 || argv[0] !== "--output")
    throw new Error(
      "Usage: tsx scripts/b17-public-contract-semantic.ts [--check | --output <new path>]",
    );
  const target = resolve(argv[1]!);
  if (existsSync(target))
    throw new Error(
      `Refusing to overwrite existing semantic contract candidate: ${target}`,
    );
  writeFileSync(target, output, { encoding: "utf8", flag: "wx" });
}
if (require.main === module)
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
