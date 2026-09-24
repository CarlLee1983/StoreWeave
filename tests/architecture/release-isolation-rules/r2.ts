import { normalizeGraph, type TargetGraph, type Violation } from './violation';

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
