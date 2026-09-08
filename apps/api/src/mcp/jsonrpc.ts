import { z } from 'zod';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_METHODS = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  ping: 'ping',
  listTools: 'tools/list',
  callTool: 'tools/call',
} as const;
export const MCP_METHOD_LIST = Object.values(MCP_METHODS);
export type McpMethod = typeof MCP_METHODS[keyof typeof MCP_METHODS];

export const jsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequest>;

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result };
}

export function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}
