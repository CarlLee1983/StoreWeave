import type { Actor, CommandDescriptor, QueryDescriptor } from '@storeweave/contracts';
import type { PermissionDefinition, PolicyDefinition } from '@storeweave/authorization';
import type { ExtensionContext, ExtensionEventHandler, ExtensionJobHandler } from './context';
import type { AnyProvider } from './providers';
import type { McpToolDefinition } from './mcp';
import { validateManifestShape, type ExtensionManifest } from './manifest';

/**
 * Extension 的 handler 收到的是 ExtensionContext，不是 CommandContext ——
 * 它拿不到 tx、db 或任何 repository。這個型別就是資料所有權邊界的執行點。
 */
export interface ExtensionInvocationContext extends Omit<import('./context').ExtensionContext<any>, 'config'> {
  readonly config: any;
  readonly actor: Actor;
  readonly correlationId: string;
}

export type ExtensionCommandHandler = (input: any, ctx: ExtensionInvocationContext) => Promise<any>;
export type ExtensionQueryHandler = (input: any, ctx: ExtensionInvocationContext) => Promise<any>;

export interface ExtensionCommandRegistration {
  descriptor: CommandDescriptor;
  handler: ExtensionCommandHandler;
}
export interface ExtensionQueryRegistration {
  descriptor: QueryDescriptor;
  handler: ExtensionQueryHandler;
}
export interface ExtensionEventRegistration {
  event: string;
  handler: ExtensionEventHandler<any>;
  maxAttempts?: number;
}
export interface ExtensionJobRegistration {
  type: string;
  handler: ExtensionJobHandler;
}

/** Extension `setup()` 的回傳值 —— 全部都是宣告，實際掛載由 Kernel 執行。 */
export interface ExtensionRegistration {
  /** Release resources acquired during setup. If setup throws before returning, it owns that cleanup. */
  close?: () => void | Promise<void>;
  commands?: ExtensionCommandRegistration[];
  queries?: ExtensionQueryRegistration[];
  events?: ExtensionEventRegistration[];
  jobs?: ExtensionJobRegistration[];
  providers?: AnyProvider[];
  policies?: PolicyDefinition[];
  permissions?: PermissionDefinition[];
  /** 對 MCP 介面公開的工具；只能指向已註冊的 Command / Query。 */
  mcpTools?: McpToolDefinition<any, any>[];
}

export interface ExtensionDefinition<TConfig = unknown> {
  readonly manifest: ExtensionManifest<TConfig>;
  setup(ctx: ExtensionContext<TConfig>): ExtensionRegistration | Promise<ExtensionRegistration>;
  /** 選用：安裝後健康檢查，供 doctor 與 /health/dependencies 使用。 */
  healthCheck?(ctx: ExtensionContext<TConfig>): Promise<{ ok: boolean; message?: string }>;
}

export function defineExtension<TConfig>(def: ExtensionDefinition<TConfig>): ExtensionDefinition<TConfig> {
  validateManifestShape(def.manifest);
  if (typeof def.setup !== 'function') {
    throw new Error(`Extension "${def.manifest.id}" must provide a setup() function`);
  }
  return def;
}
