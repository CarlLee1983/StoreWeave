import { z } from 'zod';

export const MCP_TOOL_NAMES = ['search_products', 'get_order', 'get_sales_summary', 'adjust_inventory'] as const;

export const mcpConfig = z.object({
  serverName: z.string().default('storeweave-commerce'),
  serverVersion: z.string().default('1.0.0'),
  /** 只公開清單中的工具；預設全部公開。 */
  enabledTools: z.array(z.enum(MCP_TOOL_NAMES)).default([...MCP_TOOL_NAMES]),
});

export type McpConfig = z.infer<typeof mcpConfig>;
