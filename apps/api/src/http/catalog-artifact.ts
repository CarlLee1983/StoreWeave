import { closeSync, linkSync, lstatSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import * as crypto from 'node:crypto';
import type { Runtime } from '@storeweave/kernel';
import type { HttpRouteCatalogCarrier } from './contract';

export interface WriteStartupHttpCatalogOptions {
  readonly output: string;
  readonly runtime: Runtime;
  readonly carrier: HttpRouteCatalogCarrier;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function strictJson(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('HTTP catalog contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError('HTTP catalog contains a non-JSON value');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('HTTP catalog contains a cycle');
    seen.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length) throw new TypeError('HTTP catalog contains a symbol key');
      return `[${Array.from(value, item => {
        const parsed = strictJson(item, seen);
        if (parsed === undefined) throw new TypeError('HTTP catalog array contains undefined');
        return parsed;
      }).join(',')}]`;
    } finally { seen.delete(value); }
  }
  if (typeof value !== 'object' || ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('HTTP catalog contains a non-plain object');
  }
  if (seen.has(value)) throw new TypeError('HTTP catalog contains a cycle');
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('HTTP catalog contains a symbol key');
    return `{${Object.keys(value).sort(compare).flatMap(key => {
      const parsed = strictJson((value as Record<string, unknown>)[key], seen);
      return parsed === undefined ? [] : [`${JSON.stringify(key)}:${parsed}`];
    }).join(',')}}`;
  } finally { seen.delete(value); }
}

function serializedCatalog(runtime: Runtime, carrier: HttpRouteCatalogCarrier): string {
  if (!runtime.activatedRelease) throw new Error('HTTP catalog export requires an activated release');
  const configured = runtime.config.extensions.filter(extension => extension.enabled).map(extension => extension.id).sort(compare);
  const mounted = runtime.extensions.list().map(extension => extension.id).sort(compare);
  if (configured.length !== mounted.length || configured.some((id, index) => id !== mounted[index])) {
    throw new Error('HTTP catalog export requires enabled extensions to match mounted extensions');
  }
  if (!carrier.storeweaveHttpCatalog) throw new Error('HTTP catalog export requires the startup-validated route catalog');
  const routes = [...carrier.storeweaveHttpCatalog].sort((a, b) => compare(`${a.method} ${a.path}`, `${b.method} ${b.path}`));
  const artifact = strictJson({ format: 'storeweave.http-catalog.v1', release: runtime.activatedRelease, routes });
  if (artifact === undefined) throw new Error('HTTP catalog serialization failed');
  return artifact + '\n';
}

/** Publish the startup-validated catalog once; callers must have already activated the runtime. */
export function writeStartupHttpCatalog({ output, runtime, carrier }: WriteStartupHttpCatalogOptions): void {
  const contents = serializedCatalog(runtime, carrier);
  if (!isAbsolute(output)) throw new Error('HTTP catalog output must be an absolute path');
  const parent = dirname(output);
  if (!statSync(parent, { throwIfNoEntry: false })?.isDirectory()) throw new Error('HTTP catalog output parent directory does not exist');
  if (lstatSync(output, { throwIfNoEntry: false })) throw new Error('HTTP catalog output already exists');
  const temporary = join(parent, `.${crypto.randomUUID()}.storeweave-http-catalog`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    linkSync(temporary, output);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      unlinkSync(temporary);
    }
  }
}
