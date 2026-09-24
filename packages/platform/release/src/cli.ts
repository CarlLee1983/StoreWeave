import type { TargetProjectionFactory } from './projection-factory';
import { resolveTargetProjection } from './projection-factory';
import type { ReleaseDefinition } from './release-definition';

export type CliProjectionFactory<Contribution> = TargetProjectionFactory<'cli', Contribution>;

export interface CliReleaseIdentity {
  readonly compatibleReleaseIds: readonly string[];
  readonly commandName: string;
  readonly servicePrefix: string;
  readonly filesystemName: string;
  readonly configFilename: string;
  readonly legacyEnvironmentPrefix?: string;
}

export interface CliCommandContribution<Command, Context> {
  readonly name: string;
  readonly configure: (command: Command, context: Context) => void;
}

export interface CliCommandSet<Command, Context> {
  /** Product-owned command names selected by this release. */
  readonly declared: readonly string[];
  readonly contributions: readonly CliCommandContribution<Command, Context>[];
}

export class CliProjectionContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliProjectionContributionError';
  }
}

export function assertCliProjectionRelease(releaseId: string, identity: CliReleaseIdentity): void {
  if (!identity.compatibleReleaseIds.includes(releaseId)) {
    throw new CliProjectionContributionError(
      `CLI projection for releases [${identity.compatibleReleaseIds.join(', ')}] cannot be used with release "${releaseId}"`,
    );
  }
}

export function resolveCliProjection<Contribution>(definition: ReleaseDefinition, factory: CliProjectionFactory<Contribution>): Contribution {
  return resolveTargetProjection(definition, factory);
}

/** Validates a complete product command set before the host registers any of it. */
export function validateCliCommandContributions<Command, Context>(
  releaseId: string,
  commandSet: unknown,
  reservedCommandNames: readonly string[] = [],
): readonly CliCommandContribution<Command, Context>[] {
  const source = commandSet as { declared?: unknown; contributions?: unknown } | null;
  if (!Array.isArray(source?.declared)) {
    throw new CliProjectionContributionError(`Release "${releaseId}" is missing its CLI command declarations`);
  }
  const declarations = source.declared as unknown[];
  const contributions = Array.isArray(source.contributions) ? source.contributions as unknown[] : [];
  const declared = new Set<string>();
  for (const name of declarations) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new CliProjectionContributionError(`Release "${releaseId}" declares a CLI command with an empty name`);
    }
    if (declared.has(name)) {
      throw new CliProjectionContributionError(`Release "${releaseId}" has duplicate CLI command "${name}"`);
    }
    declared.add(name);
  }

  const byName = new Map<string, CliCommandContribution<Command, Context>>();
  for (const value of contributions) {
    const contribution = value as CliCommandContribution<Command, Context> | null;
    const name = contribution?.name;
    if (!contribution || typeof name !== 'string' || name.trim() === '') {
      throw new CliProjectionContributionError(`Release "${releaseId}" has a CLI contribution without a command name`);
    }
    if (byName.has(name)) {
      throw new CliProjectionContributionError(`Release "${releaseId}" has duplicate CLI contribution for command "${name}"`);
    }
    byName.set(name, contribution);
  }

  const reserved = new Set(reservedCommandNames);
  for (const name of declared) {
    const contribution = byName.get(name);
    if (!contribution || typeof contribution.configure !== 'function') {
      throw new CliProjectionContributionError(`Release "${releaseId}" is missing CLI contribution for command "${name}"`);
    }
    if (reserved.has(name)) {
      throw new CliProjectionContributionError(`Release "${releaseId}" has duplicate CLI command "${name}"`);
    }
  }

  for (const name of byName.keys()) {
    if (!declared.has(name)) {
      throw new CliProjectionContributionError(`Release "${releaseId}" has undeclared CLI contribution for command "${name}"`);
    }
  }

  return [...declared].map(name => byName.get(name)!);
}
