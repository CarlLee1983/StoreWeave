import { PlatformError } from '@storeweave/contracts';
import type { McpToolDefinition } from '@storeweave/extension-sdk';

export interface RegisteredMcpTool {
  definition: McpToolDefinition<any, any>;
  owner: string;
}

/** 平台層的 MCP 工具目錄。介面轉接（JSON-RPC）住在 apps/api，不住在這裡。 */
export class McpToolRegistry {
  private readonly tools = new Map<string, RegisteredMcpTool>();

  register(definition: McpToolDefinition<any, any>, owner: string): void {
    if (this.tools.has(definition.name)) {
      throw PlatformError.conflict(`MCP tool "${definition.name}" already registered by "${this.tools.get(definition.name)!.owner}"`);
    }
    this.tools.set(definition.name, { definition, owner });
  }

  get(name: string): RegisteredMcpTool {
    const tool = this.tools.get(name);
    if (!tool) throw PlatformError.notFound('MCP tool', name);
    return tool;
  }

  list(): RegisteredMcpTool[] {
    return [...this.tools.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  get size(): number {
    return this.tools.size;
  }
}
