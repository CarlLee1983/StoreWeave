import { PlatformError } from '@storeweave/contracts';
import type { JobConcurrencyPolicy, JobHandler } from '@storeweave/jobs';
import { z } from 'zod';

export interface JobPayloadContract {
  /** The only version written by new enqueue callers. */
  readonly currentVersion: number;
  /** A schema for every persisted version this owner promises to read. */
  readonly versions: Readonly<Record<number, z.ZodType<unknown>>>;
  /** A one-step, explicit migration from version n to n + 1. */
  readonly upgrades?: Readonly<Record<number, (payload: unknown) => unknown>>;
  /** Declared now; enforcement belongs to B04 slice 3. */
  readonly execution?: { readonly timeoutMs?: number; readonly concurrencyKey?: string; readonly concurrencyLimit?: number };
}

export interface RegisteredJobDefinition {
  readonly type: string;
  readonly handler: JobHandler;
  readonly contract: JobPayloadContract;
}

export interface JobExecutionPolicy {
  readonly timeoutMs: number;
  readonly concurrencyKey: string;
  readonly concurrencyLimit?: number;
}

export class JobPayloadDecodeError extends Error {
  constructor(readonly type: string, readonly payloadVersion: number, message: string) {
    super(message);
    this.name = 'JobPayloadDecodeError';
  }
}

function normalizeContract(type: string, contract: JobPayloadContract): JobPayloadContract {
  if (!Number.isInteger(contract.currentVersion) || contract.currentVersion < 1) {
    throw PlatformError.validation(`Job "${type}" needs a positive integer currentVersion`);
  }
  const versions = Object.keys(contract.versions).map(Number).sort((a, b) => a - b);
  if (versions.length === 0 || versions.some(version => !Number.isInteger(version) || version < 1)) {
    throw PlatformError.validation(`Job "${type}" must declare schemas for positive payload versions`);
  }
  if (!contract.versions[contract.currentVersion]) {
    throw PlatformError.validation(`Job "${type}" has no schema for current payload version ${contract.currentVersion}`);
  }
  for (let version = 1; version < contract.currentVersion; version += 1) {
    if (!contract.versions[version] || !contract.versions[version + 1]) {
      throw PlatformError.validation(`Job "${type}" must declare schemas for every persisted version through ${contract.currentVersion}`);
    }
  }
  const execution = contract.execution;
  if (execution?.timeoutMs !== undefined && (!Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs <= 0)) {
    throw PlatformError.validation(`Job "${type}" execution timeout must be a positive integer`);
  }
  if (execution?.concurrencyLimit !== undefined && (!Number.isSafeInteger(execution.concurrencyLimit) || execution.concurrencyLimit <= 0)) {
    throw PlatformError.validation(`Job "${type}" concurrency limit must be a positive integer`);
  }
  if (execution?.concurrencyKey !== undefined && (!execution.concurrencyKey.trim() || execution.concurrencyKey.length > 200)) {
    throw PlatformError.validation(`Job "${type}" concurrency key must be non-empty and at most 200 characters`);
  }
  if (execution?.concurrencyKey !== undefined && execution.concurrencyLimit === undefined) {
    throw PlatformError.validation(`Job "${type}" concurrency key requires a positive concurrency limit`);
  }
  return Object.freeze({ ...contract, versions: Object.freeze({ ...contract.versions }), upgrades: Object.freeze({ ...contract.upgrades }) });
}

export class JobRegistry {
  private readonly handlers = new Map<string, { definition?: RegisteredJobDefinition; handler: JobHandler; owner: string }>();

  register(type: string, handler: JobHandler, owner: string, contract?: JobPayloadContract): void {
    if (this.handlers.has(type)) {
      throw PlatformError.conflict(`Job type "${type}" already registered by "${this.handlers.get(type)!.owner}"`);
    }
    const normalized = contract && normalizeContract(type, contract);
    if (normalized?.execution?.concurrencyLimit !== undefined) {
      const key = normalized.execution.concurrencyKey ?? type;
      for (const existing of this.handlers.values()) {
        const current = existing.definition?.contract.execution;
        if (current?.concurrencyLimit !== undefined && (current.concurrencyKey ?? existing.definition!.type) === key
          && current.concurrencyLimit !== normalized.execution.concurrencyLimit) {
          throw PlatformError.validation(`Job concurrency key "${key}" has conflicting limits ${current.concurrencyLimit} and ${normalized.execution.concurrencyLimit}`);
        }
      }
    }
    this.handlers.set(type, normalized
      ? { handler, owner, definition: Object.freeze({ type, handler, contract: normalized }) }
      : { handler, owner });
  }

  get(type: string): JobHandler {
    const entry = this.handlers.get(type);
    if (!entry) throw PlatformError.notFound('Job handler', type);
    return entry.handler;
  }

  definition(type: string): RegisteredJobDefinition {
    const entry = this.handlers.get(type);
    if (!entry) throw PlatformError.notFound('Job handler', type);
    if (!entry.definition) throw PlatformError.validation(`Job payload cutover blocked: ${entry.owner} owns "${type}" without jobContractV1 metadata`);
    return entry.definition;
  }

  currentVersion(type: string): number { return this.definition(type).contract.currentVersion; }

  executionFor(type: string): JobExecutionPolicy {
    const execution = this.definition(type).contract.execution;
    return Object.freeze({
      timeoutMs: execution?.timeoutMs ?? 300_000,
      concurrencyKey: execution?.concurrencyKey ?? type,
      concurrencyLimit: execution?.concurrencyLimit,
    });
  }

  claimConcurrencyPolicies(): readonly JobConcurrencyPolicy[] {
    return [...this.handlers.keys()].sort().map(type => {
      const execution = this.executionFor(type);
      return Object.freeze({ type, key: execution.concurrencyKey, limit: execution.concurrencyLimit });
    });
  }

  /** Decode before handler execution. Invalid source/current schemas never reach owner code. */
  decode(type: string, payload: unknown, sourceVersion: number): unknown {
    const definition = this.definition(type);
    const contract = definition.contract;
    if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > contract.currentVersion) {
      throw new JobPayloadDecodeError(type, sourceVersion, `unknown payload version ${sourceVersion}; current is ${contract.currentVersion}`);
    }
    let version = sourceVersion;
    const sourceSchema = contract.versions[version];
    if (!sourceSchema) throw new JobPayloadDecodeError(type, version, `no schema for payload version ${version}`);
    let decoded = sourceSchema.safeParse(payload);
    if (!decoded.success) throw new JobPayloadDecodeError(type, version, `payload v${version} is invalid: ${decoded.error.message}`);
    let value = decoded.data;
    while (version < contract.currentVersion) {
      const upgrade = contract.upgrades?.[version];
      if (!upgrade) throw new JobPayloadDecodeError(type, version, `missing payload upgrader ${version} -> ${version + 1}`);
      try { value = upgrade(value); }
      catch (error) { throw new JobPayloadDecodeError(type, version, `payload upgrader ${version} -> ${version + 1} failed: ${(error as Error).message}`); }
      version += 1;
      decoded = contract.versions[version]!.safeParse(value);
      if (!decoded.success) throw new JobPayloadDecodeError(type, version, `upgraded payload v${version} is invalid: ${decoded.error.message}`);
      value = decoded.data;
    }
    return value;
  }

  /** Explicit cutover diagnostic: legacy extension declarations cannot use the fenced dispatcher. */
  assertPayloadDispatchReady(): void {
    const pending = [...this.handlers.entries()]
      .filter(([, entry]) => !entry.definition)
      .map(([type, entry]) => `${entry.owner}:${type}`)
      .sort();
    if (pending.length) throw PlatformError.validation(`Job payload cutover blocked; migrate active job owners: ${pending.join(', ')}`);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
