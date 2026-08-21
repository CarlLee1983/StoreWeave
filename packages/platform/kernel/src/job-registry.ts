import { PlatformError } from '@storeweave/contracts';
import type { JobHandler } from '@storeweave/jobs';

export class JobRegistry {
  private readonly handlers = new Map<string, { handler: JobHandler; owner: string }>();

  register(type: string, handler: JobHandler, owner: string): void {
    if (this.handlers.has(type)) {
      throw PlatformError.conflict(`Job type "${type}" already registered by "${this.handlers.get(type)!.owner}"`);
    }
    this.handlers.set(type, { handler, owner });
  }

  get(type: string): JobHandler {
    const entry = this.handlers.get(type);
    if (!entry) throw PlatformError.notFound('Job handler', type);
    return entry.handler;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
