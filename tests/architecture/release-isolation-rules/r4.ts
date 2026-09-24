import { normalizeGraph, type TargetGraph, type Violation } from './violation';

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
