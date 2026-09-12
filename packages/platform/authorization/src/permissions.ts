import { PlatformError } from '@storeweave/contracts';

export interface PermissionDefinition {
  readonly key: string;
  readonly description: string;
  /** 宣告來源：core 模組名稱或 extension id。 */
  readonly owner: string;
}

/** `catalog:write` 這種格式；`*` 只保留給 system actor。 */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export class PermissionRegistry {
  private readonly byKey = new Map<string, PermissionDefinition>();

  assertAvailable(def: PermissionDefinition): void {
    if (!PERMISSION_PATTERN.test(def.key)) {
      throw PlatformError.validation(`Invalid permission key "${def.key}"; expected e.g. catalog:write`);
    }
    const existing = this.byKey.get(def.key);
    if (existing && existing.owner !== def.owner) {
      throw PlatformError.conflict(
        `Permission "${def.key}" already declared by "${existing.owner}"`,
      );
    }
  }

  register(def: PermissionDefinition): void {
    this.assertAvailable(def);
    this.byKey.set(def.key, def);
  }

  registerMany(defs: readonly PermissionDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  list(): PermissionDefinition[] {
    return [...this.byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  assertKnown(key: string, context: string): void {
    if (!this.byKey.has(key)) {
      throw PlatformError.validation(`Unknown permission "${key}" referenced by ${context}`);
    }
  }
}
