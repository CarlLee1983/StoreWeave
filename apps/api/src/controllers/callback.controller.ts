import { createHash } from 'node:crypto';
import { Controller, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
import type { PaymentCallbackEvent, PaymentProvider } from '@storeweave/extension-sdk';
import { ExternalCallback, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { RUNTIME, type Runtime } from '../tokens';
import { Inject } from '@nestjs/common';

type CallbackRequest = AuthenticatedRequest & { rawBody?: Uint8Array };
type CallbackQuery = Record<string, string | string[] | undefined>;

/**
 * HTTP belongs to the platform, not an extension. A provider receives the original
 * material, verifies/parses it atomically, and the normalized result then goes through
 * the ordinary Order command so callbacks and workers share the same state machine.
 */
@ExternalCallback()
@Controller('callbacks')
export class CallbackController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Post(':kind/:providerId')
  async handlePayment(
    @Param('kind') kind: string,
    @Param('providerId') providerId: string,
    @Query() query: CallbackQuery,
    @Req() request: CallbackRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Keep the generic path for future kinds without pretending arbitrary provider
    // interfaces exist today.
    if (kind !== 'payment') {
      void reply.status(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }

    let provider: PaymentProvider;
    try {
      provider = this.runtime.providers.get<PaymentProvider>('payment', providerId);
    } catch {
      void reply.status(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }

    try {
      if (!request.rawBody) throw new Error('Raw callback body was not captured');
      const event = await provider.parseCallback({
        body: request.rawBody,
        headers: request.headers,
        query,
      });
      await this.runtime.commands.execute(
        'commerce.order.recordPaymentResult',
        paymentResultInput(provider.id, event),
        {
          actor: SYSTEM_ACTOR,
          idempotencyKey: callbackIdempotencyKey(provider.id, event),
          correlationId: correlationIdOf(request),
          channel: 'rest',
        },
      );
      this.sendAcknowledgement(reply, provider, true);
    } catch (error) {
      // Never log raw body, CheckMacValue, or payment fields. The provider chooses
      // retry semantics from this acknowledgement, so do not let the JSON filter
      // replace it with a generic error envelope.
      this.runtime.logger.warn({ kind, providerId, errorType: error instanceof Error ? error.name : typeof error }, 'external callback rejected');
      this.sendAcknowledgement(reply, provider, false);
    }
  }

  private sendAcknowledgement(reply: FastifyReply, provider: PaymentProvider, accepted: boolean): void {
    const acknowledgement = provider.acknowledgeCallback({ accepted });
    for (const [name, value] of Object.entries(acknowledgement.headers ?? {})) reply.header(name, value);
    void reply.status(acknowledgement.statusCode ?? (accepted ? 200 : 500)).send(acknowledgement.body);
  }
}

function paymentResultInput(provider: string, event: PaymentCallbackEvent): Record<string, unknown> {
  switch (event.type) {
    case 'payment_confirmed':
      return { attemptRef: event.reference, provider, status: 'confirmed', providerRef: event.providerRef };
    case 'payment_info_issued':
      return {
        attemptRef: event.reference,
        provider,
        status: 'awaiting_payment',
        providerRef: event.providerRef,
        instructions: [...event.instructions],
        expiresAt: event.expiresAt,
      };
    case 'payment_failed':
      return {
        attemptRef: event.reference,
        provider,
        status: 'failed',
        ...(event.providerRef ? { providerRef: event.providerRef } : {}),
        ...(event.message ? { message: event.message } : {}),
      };
  }
}

/** A fixed-size opaque key avoids delimiter collisions and keeps provider data out of the idempotency table. */
function callbackIdempotencyKey(provider: string, event: PaymentCallbackEvent): string {
  const identity = event.type === 'payment_info_issued'
    ? { provider, type: event.type, reference: event.reference, providerRef: event.providerRef, expiresAt: event.expiresAt, instructions: event.instructions }
    : { provider, type: event.type, reference: event.reference, providerRef: event.providerRef ?? null };
  return `callback:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
