import { createHash } from 'node:crypto';
import { Controller, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
import type { PaymentCallbackEvent, PaymentProvider, ShippingCallbackEvent, ShippingProvider } from '@storeweave/extension-sdk';
import { ExternalCallback, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { HttpContract, type ProviderCallbackHttpContract } from '../http/contract';
import { RUNTIME, type Runtime } from '../tokens';
import { Inject } from '@nestjs/common';

type CallbackRequest = AuthenticatedRequest & { rawBody?: Uint8Array };
type CallbackQuery = Record<string, string | string[] | undefined>;

const callbackRoute = {
  kind: 'provider-callback', request: 'raw', providerKinds: ['payment', 'shipping'], rateLimit: 'callback',
} satisfies ProviderCallbackHttpContract;

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
  @HttpContract(callbackRoute)
  async handlePayment(
    @Param('kind') kind: string,
    @Param('providerId') providerId: string,
    @Query() query: CallbackQuery,
    @Req() request: CallbackRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (kind === 'shipping') {
      await this.handleShipping(providerId, query, request, reply);
      return;
    }
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

  private async handleShipping(
    providerId: string,
    query: CallbackQuery,
    request: CallbackRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let provider: ShippingProvider;
    try {
      provider = this.runtime.providers.get<ShippingProvider>('shipping', providerId);
    } catch {
      void reply.status(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    if (!provider.parseCallback || !provider.acknowledgeCallback) {
      void reply.status(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    try {
      if (!request.rawBody) throw new Error('Raw callback body was not captured');
      const event = await provider.parseCallback({ body: request.rawBody, headers: request.headers, query });
      await this.runtime.commands.execute(
        'commerce.shipping.recordProviderCallback',
        shippingCallbackInput(provider.id, event, request.rawBody),
        {
          actor: SYSTEM_ACTOR,
          idempotencyKey: shippingCallbackIdempotencyKey(provider.id, event),
          correlationId: correlationIdOf(request),
          channel: 'rest',
        },
      );
      this.sendShippingAcknowledgement(reply, provider, true);
    } catch (error) {
      this.runtime.logger.warn({ kind: 'shipping', providerId, errorType: error instanceof Error ? error.name : typeof error }, 'external callback rejected');
      this.sendShippingAcknowledgement(reply, provider, false);
    }
  }

  private sendAcknowledgement(reply: FastifyReply, provider: PaymentProvider, accepted: boolean): void {
    const acknowledgement = provider.acknowledgeCallback({ accepted });
    for (const [name, value] of Object.entries(acknowledgement.headers ?? {})) reply.header(name, value);
    void reply.status(acknowledgement.statusCode ?? (accepted ? 200 : 500)).send(acknowledgement.body);
  }

  private sendShippingAcknowledgement(reply: FastifyReply, provider: ShippingProvider, accepted: boolean): void {
    const acknowledgement = provider.acknowledgeCallback!({ accepted });
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

/**
 * The signed bytes are durable private evidence. Base64 preserves arbitrary
 * payloads without interpreting or logging carrier-controlled fields.
 */
function shippingCallbackInput(provider: string, event: ShippingCallbackEvent, rawBody: Uint8Array): Record<string, unknown> {
  return {
    provider, providerRef: event.providerRef, rawStatus: event.rawStatus,
    callbackPayloadBase64: Buffer.from(rawBody).toString('base64'),
    ...(event.stage ? { stage: event.stage } : {}),
    callbackId: event.callbackId,
    ...(event.trackingUrl ? { trackingUrl: event.trackingUrl } : {}),
  };
}

/** Callback identity is provider-verified and hashed before it reaches durable idempotency storage. */
function shippingCallbackIdempotencyKey(provider: string, event: ShippingCallbackEvent): string {
  return `shipping-callback:${createHash('sha256').update(JSON.stringify({ provider, callbackId: event.callbackId })).digest('hex')}`;
}
