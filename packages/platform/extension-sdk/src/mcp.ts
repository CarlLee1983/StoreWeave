import { z, type ZodType, type ZodTypeDef } from 'zod';

type Schema<T> = ZodType<T, ZodTypeDef, any>;

/**
 * MCP 工具宣告。
 * 工具只能指向 Command Bus 或 Query Bus 上已註冊的名稱 —— 這個型別本身就讓
 * 「MCP 直接存取 repository 或資料庫」變成無法表達的東西。
 */
export interface McpToolDefinition<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema<I>;
  readonly target: { readonly kind: 'command' | 'query'; readonly name: string };
  /** 把工具輸入轉成 Command/Query 的輸入 DTO。 */
  readonly mapInput?: (input: I) => unknown;
  /** 把 Command/Query 的輸出轉成工具回應。 */
  readonly mapOutput?: (output: any) => O;
  /** 寫入型工具必須帶 Idempotency Key。 */
  readonly requiresIdempotencyKey?: boolean;
}

export const MCP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export function defineMcpTool<I, O = unknown>(def: McpToolDefinition<I, O>): McpToolDefinition<I, O> {
  if (!MCP_TOOL_NAME_PATTERN.test(def.name)) {
    throw new Error(`Invalid MCP tool name "${def.name}"`);
  }
  if (def.target.kind === 'command' && !def.requiresIdempotencyKey) {
    throw new Error(`MCP tool "${def.name}" targets a command and must set requiresIdempotencyKey`);
  }
  return def;
}

export const mcpToolListEntry = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
