import { createHash, randomUUID } from 'node:crypto';
import { Controller, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
import type { PaymentCallbackEvent, PaymentProviderV2 } from '@storeweave/extension-sdk';
import { ExternalCallback, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { HttpContract, type ProviderCallbackHttpContract } from '../http/contract';
import { RUNTIME, type Runtime } from '../tokens';

type CallbackRequest = AuthenticatedRequest & { rawBody?: Uint8Array };
type CallbackQuery = Record<string, string | string[] | undefined>;
type CallbackProvider = Pick<PaymentProviderV2, 'id' | 'parseCallback' | 'acknowledgeCallback'>;

const callbackRoute = {
  kind: 'provider-callback', request: 'raw', providerKinds: ['payment'], rateLimit: 'callback',
} as const satisfies ProviderCallbackHttpContract;

/** Booking alone owns this provider-to-Reservation bridge. The provider verifies; the Reservation command decides the outcome. */
@ExternalCallback()
@Controller('callbacks')
export class BookingCallbackController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Post(':kind/:providerId')
  @HttpContract(callbackRoute)
  async handle(
    @Param('kind') kind: string,
    @Param('providerId') providerId: string,
    @Query() query: CallbackQuery,
    @Req() request: CallbackRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const correlationId = safeCorrelationId(request);
    if (kind !== 'payment') {
      this.runtime.logger.warn({ correlationId, outcome: 'unsupported-kind' }, 'booking payment callback rejected');
      notFound(reply);
      return;
    }

    let provider: CallbackProvider;
    try {
      provider = this.runtime.providers.get<PaymentProviderV2>('payment', providerId);
    } catch {
      this.runtime.logger.warn({ correlationId, outcome: 'unknown-provider' }, 'booking payment callback rejected');
      notFound(reply);
      return;
    }

    try {
      if (!request.rawBody) throw new Error('MissingRawCallbackBody');
      const event = await provider.parseCallback({ body: request.rawBody, headers: request.headers, query });
      await this.runtime.commands.execute('booking.reservation.recordVerifiedPaymentOutcome',
        { provider: provider.id, event },
        { actor: SYSTEM_ACTOR, idempotencyKey: callbackIdempotencyKey(provider.id, event), correlationId, channel: 'rest' });
      this.runtime.logger.info({ correlationId, providerId: provider.id, outcome: 'accepted' }, 'booking payment callback handled');
      acknowledge(reply, provider, true);
    } catch (error) {
      // Neither raw callback bytes nor provider-controlled error text belong in diagnostics.
      this.runtime.logger.warn({ correlationId, providerId: provider.id, outcome: 'rejected',
        errorType: error instanceof Error ? error.name : typeof error }, 'booking payment callback rejected');
      acknowledge(reply, provider, false);
    }
  }
}

function safeCorrelationId(request: AuthenticatedRequest): string {
  const presented = correlationIdOf(request);
  return presented && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(presented)
    ? presented : randomUUID();
}

function callbackIdempotencyKey(provider: string, event: PaymentCallbackEvent): string {
  return `booking-callback:${createHash('sha256').update(JSON.stringify({ provider, event })).digest('hex')}`;
}

function acknowledge(reply: FastifyReply, provider: CallbackProvider, accepted: boolean): void {
  const response = provider.acknowledgeCallback({ accepted });
  for (const [name, value] of Object.entries(response.headers ?? {})) reply.header(name, value);
  void reply.status(response.statusCode ?? (accepted ? 200 : 500)).send(response.body);
}

function notFound(reply: FastifyReply): void {
  void reply.status(404).type('text/plain; charset=utf-8').send('Not found');
}
