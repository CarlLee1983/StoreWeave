import { relative, resolve } from 'node:path';

/**
 * Shared vocabulary for SW-144 (ADR 0052 falsifier: Booking excludes Commerce implementation,
 * Platform/Base carries no product branch, target projections carry no foreign executable).
 * No I/O here except reading text/graphs the caller already collected — see
 * `../release-isolation-artifacts.ts` for how real artifacts are gathered.
 */

export type Rule = 'R1' | 'R2' | 'R3' | 'R4';
export interface Violation { readonly rule: Rule; readonly subject: string; readonly path: string; readonly reason: string }
export type ReleaseId = 'base' | 'commerce' | 'booking';
export type ProductId = 'commerce' | 'booking';
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

export function normalizeGraph(root: string, graph: TargetGraph): string[] {
  return [...new Set(graph.inputs.map(input => normalizePath(root, input)))];
}
