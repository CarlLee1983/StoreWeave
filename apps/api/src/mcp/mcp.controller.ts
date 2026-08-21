import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlatformError, toPublicError } from '@storeweave/contracts';
import { ok } from '../http/envelope';
import { actorOf, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { RUNTIME, type Runtime } from '../tokens';
import { JSON_RPC_ERRORS, jsonRpcRequest, rpcError, rpcResult } from './jsonrpc';

const PROTOCOL_VERSION = '2025-06-18';

/**
 * MCP 是一個 Interface Adapter，和 REST、Admin、CLI 完全平行。
 * 它唯一能做的事，就是把已註冊的工具轉發給 Command Bus 或 Query Bus ——
 * 這個檔案裡沒有 repository、沒有 SQL、也拿不到資料庫連線。
 */
@Controller()
export class McpController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Get('mcp')
  describe() {
    return ok({
      protocolVersion: PROTOCOL_VERSION,
      transport: 'http-jsonrpc',
      tools: this.runtime.mcpTools.list().map((t) => ({
        name: t.definition.name,
        owner: t.owner,
        target: t.definition.target,
      })),
    });
  }

  @Post('mcp')
  @HttpCode(200)
  async rpc(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = jsonRpcRequest.safeParse(body);
    if (!parsed.success) {
      return rpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const { id, method, params } = parsed.data;

    try {
      switch (method) {
        case 'initialize':
          return rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `${this.runtime.config.store.id}-commerce`, version: this.runtime.platformVersion },
          });
        case 'notifications/initialized':
          return rpcResult(id, {});
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: this.listTools() });
        case 'tools/call':
          return rpcResult(id, await this.callTool(request, params));
        default:
          return rpcError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method "${method}"`);
      }
    } catch (err) {
      const publicError = toPublicError(err);
      if (err instanceof PlatformError && err.httpStatus < 500) {
        // 工具層級的錯誤依 MCP 慣例回在 result 裡，讓客戶端可以自我修正
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `${publicError.code}: ${publicError.message}` }],
        });
      }
      this.runtime.logger.error({ method, error: (err as Error).message }, 'mcp call failed');
      return rpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, publicError.message);
    }
  }

  private listTools() {
    return this.runtime.mcpTools.list().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: zodToJsonSchema(t.definition.input as never, { target: 'jsonSchema7' }),
    }));
  }

  private async callTool(request: AuthenticatedRequest, params: unknown) {
    const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };
    if (!name) throw PlatformError.validation('tools/call requires a tool name');

    const { definition } = this.runtime.mcpTools.get(name);
    const parsed = definition.input.safeParse(args ?? {});
    if (!parsed.success) {
      throw PlatformError.validation(`Invalid arguments for tool "${name}"`, parsed.error.issues);
    }

    const actor = actorOf(request);
    const correlationId = correlationIdOf(request);
    const input = definition.mapInput ? definition.mapInput(parsed.data) : parsed.data;

    let output: unknown;
    if (definition.target.kind === 'query') {
      output = await this.runtime.queries.execute(definition.target.name, input, { actor, correlationId, channel: 'mcp' });
    } else {
      const idempotencyKey = (parsed.data as { idempotencyKey?: string }).idempotencyKey;
      if (!idempotencyKey) throw PlatformError.validation(`Tool "${name}" requires an idempotencyKey`);
      output = await this.runtime.commands.execute(definition.target.name, input, {
        actor, idempotencyKey, correlationId, channel: 'mcp',
      });
    }

    const mapped = definition.mapOutput ? definition.mapOutput(output) : output;
    return {
      content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
      structuredContent: mapped,
    };
  }
}
