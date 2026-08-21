import {
  PlatformError,
  type Actor,
  type Logger,
  type QueryContext,
  type QueryDescriptor,
  type QueryHandler,
} from '@storeweave/contracts';
import type { Database } from '@storeweave/db';
import type { AuthorizationService } from '@storeweave/authorization';

export interface QueryRegistration {
  descriptor: QueryDescriptor;
  handler: QueryHandler;
  owner: string;
}

export interface QueryExecuteOptions {
  actor: Actor;
  correlationId?: string;
  channel?: 'rest' | 'mcp' | 'cli' | 'admin' | 'internal' | 'worker';
}

export interface QueryBusDeps {
  database: Database;
  authorization: AuthorizationService;
  logger: Logger;
}

/** 唯一的讀取入口，與 CommandBus 對稱。 */
export class QueryBus {
  private readonly registry = new Map<string, QueryRegistration>();

  constructor(private readonly deps: QueryBusDeps) {}

  register(descriptor: QueryDescriptor, handler: QueryHandler, owner: string): void {
    if (this.registry.has(descriptor.name)) {
      throw PlatformError.conflict(`Query "${descriptor.name}" already registered`);
    }
    this.deps.authorization.permissions.assertKnown(descriptor.permission, `query ${descriptor.name}`);
    this.registry.set(descriptor.name, { descriptor, handler, owner });
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  get(name: string): QueryRegistration {
    const reg = this.registry.get(name);
    if (!reg) throw PlatformError.notFound('Query', name);
    return reg;
  }

  list(): QueryRegistration[] {
    return [...this.registry.values()].sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  }

  async execute<O = unknown>(name: string, rawInput: unknown, options: QueryExecuteOptions): Promise<O> {
    const { descriptor, handler } = this.get(name);
    const correlationId = options.correlationId ?? require('node:crypto').randomUUID();

    this.deps.authorization.assert({
      actor: options.actor,
      permission: descriptor.permission,
      resource: { type: descriptor.name.split('.')[1] ?? 'unknown' },
    });

    const parsed = descriptor.input.safeParse(rawInput);
    if (!parsed.success) {
      throw PlatformError.validation(`Invalid input for "${name}"`, parsed.error.issues);
    }

    const ctx: QueryContext = {
      actor: options.actor,
      db: this.deps.database.db,
      logger: this.deps.logger.child({ query: name, correlationId, channel: options.channel ?? 'internal' }),
      correlationId,
    };

    const result = await handler(parsed.data, ctx);
    const output = descriptor.output.safeParse(result);
    if (!output.success) {
      throw PlatformError.internal(`Query "${name}" produced invalid output`, output.error.issues);
    }
    return output.data as O;
  }
}
