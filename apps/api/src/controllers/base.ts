import { Inject } from '@nestjs/common';
import { RUNTIME, type Runtime } from '../tokens';
import { actorOf, correlationIdOf, idempotencyKeyOf, type AuthenticatedRequest } from '../http/auth';
import { busHttpInput, type BusHttpContract } from '../http/contract';
import { ok } from '../http/envelope';

/**
 * 所有 HTTP 控制器共用的基底。
 * 控制器只做「HTTP → Command/Query Bus」的轉換 —— 它沒有 repository，也沒有資料庫。
 */
export abstract class BusController {
  constructor(@Inject(RUNTIME) protected readonly runtime: Runtime) {}

  protected async rest(request: AuthenticatedRequest, contract: BusHttpContract, input: unknown, params?: Record<string, string>) {
    const mapped = busHttpInput(contract, input, params);
    return ok(await (contract.target.kind === 'command'
      ? this.command(request, contract.target.name, mapped)
      : this.query(request, contract.target.name, mapped)));
  }

  protected command<O>(request: AuthenticatedRequest, name: string, input: unknown): Promise<O> {
    return this.runtime.commands.execute<O>(name, input, {
      actor: actorOf(request),
      idempotencyKey: idempotencyKeyOf(request),
      correlationId: correlationIdOf(request),
      channel: 'rest',
    });
  }

  protected query<O>(request: AuthenticatedRequest, name: string, input: unknown): Promise<O> {
    return this.runtime.queries.execute<O>(name, input, {
      actor: actorOf(request),
      correlationId: correlationIdOf(request),
      channel: 'rest',
    });
  }
}
