import { PlatformError } from '@storeweave/contracts';
import type { McpToolDefinition } from '@storeweave/extension-sdk';

function forwardable(args: unknown, kind: 'command' | 'query'): unknown {
  if (kind !== 'command' || typeof args !== 'object' || args === null) return args;
  const { idempotencyKey: _dropped, ...rest } = args as Record<string, unknown>;
  return rest;
}

/** The single production boundary for MCP input parsing, mapping and command idempotency extraction. */
export function prepareMcpToolInvocation(definition: McpToolDefinition<any, any>, args: unknown): {
  readonly input: unknown;
  readonly idempotencyKey?: string;
} {
  const parsed = definition.input.safeParse(args ?? {});
  if (!parsed.success) {
    throw PlatformError.validation(`Invalid arguments for tool "${definition.name}"`, parsed.error.issues);
  }
  const input = definition.mapInput
    ? definition.mapInput(parsed.data)
    : forwardable(parsed.data, definition.target.kind);
  if (definition.target.kind === 'query') return { input };

  const idempotencyKey = (parsed.data as { idempotencyKey?: string }).idempotencyKey;
  if (!idempotencyKey) {
    throw PlatformError.validation(`Tool "${definition.name}" requires an idempotencyKey`);
  }
  return { input, idempotencyKey };
}
