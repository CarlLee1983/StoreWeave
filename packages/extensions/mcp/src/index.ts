import { defineExtension } from '@storeweave/extension-sdk';
import { mcpConfig, type McpConfig } from './config';
import { ALL_MCP_TOOLS } from './tools';

export const mcpExtension = defineExtension<McpConfig>({
  manifest: {
    id: 'mcp',
    name: 'MCP Interface',
    version: '1.0.0',
    platformVersion: '^1.0.0',
    description: '把 Command Bus 與 Query Bus 上的能力，以 MCP 工具形式公開給 AI 客戶端。',
    permissions: [],
    configuration: mcpConfig,
    subscribedEvents: [],
    registeredCommands: [],
    registeredQueries: [],
    registeredProviders: [],
  },
  setup(ctx) {
    const enabled = new Set(ctx.config.enabledTools);
    return { mcpTools: ALL_MCP_TOOLS.filter((tool) => enabled.has(tool.name as any)) };
  },
  async healthCheck(ctx) {
    return { ok: true, message: `${ctx.config.enabledTools.length} tools exposed as ${ctx.config.serverName}` };
  },
});

export * from './config';
export * from './tools';
export default mcpExtension;
