import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, type Actor, type Tx } from '@storeweave/contracts';
import { sha256Hex } from '@storeweave/crypto';
import {
  bookingQuoteInputSchema, bookingQuoteResultSchema, bookingQuoteSchema, bookingSearchInputSchema, bookingSearchResultSchema,
} from '@storeweave/booking-availability';
import { propertyDtoSchema, roomTypeDtoSchema } from '@storeweave/booking-property';
import {
  createBookingReservationInputSchema,
  createBookingReservationCheckoutAccess,
} from '@storeweave/booking-reservation';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { Anonymous, correlationIdOf, type AuthenticatedRequest } from '../http/auth';
import { ok } from '../http/envelope';
import { SchemaPipe } from '../http/validation';
import { RUNTIME, type Runtime } from '../tokens';
import { BOOKING_PUBLIC_CLIENT_COOKIE, hostCookie, readCookie } from '../http/cookie-names';

const bookingPublicPermissions = ['booking-property:public-read', 'booking-availability:quote', 'booking-reservation:create', 'booking-reservation:pay'];

const roomTypeParamsSchema = z.object({ roomTypeId: z.string().uuid() }).strict();
const reservationParamsSchema = z.object({ reservationId: z.string().uuid() }).strict();
const paymentBodySchema = z.object({ method: z.string().trim().min(1).max(100) }).strict();
const idempotencyKeySchema = z.string().uuid().refine(value => value[14] === '4' && ['8', '9', 'a', 'b'].includes(value[19] ?? ''), 'Expected UUIDv4');

const emptyInputSchema = z.object({}).strict();
const publicReservationSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('pending_payment'),
  paymentExpiresAt: z.string().datetime(),
}).strict();
const createResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('created'), reservation: publicReservationSchema,
    checkoutCredential: z.string().regex(/^brc1\.[A-Za-z0-9_-]+$/), checkoutCredentialExpiresAt: z.string().datetime(),
  }).strict(),
  z.object({ kind: z.literal('stale'), replacementQuote: bookingQuoteSchema }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);
const paymentResponseSchema = z.object({
  attemptId: z.string().uuid(), status: z.string(), expiresAt: z.string().datetime(),
}).strict();
const responseSchema = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data }).strict();
const jsonSchema = (schema: z.ZodTypeAny) => zodToJsonSchema(schema as never, { target: 'jsonSchema7' });

const routes = {
  property: { kind: 'direct', request: 'none', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(z.object({ property: propertyDtoSchema.nullable() }).strict())) },
  roomTypes: { kind: 'direct', request: 'none', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(z.object({ items: z.array(roomTypeDtoSchema) }).strict())) },
  roomType: { kind: 'direct', request: 'none', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(z.object({ roomType: roomTypeDtoSchema }).strict())) },
  quote: { kind: 'direct', request: 'body', input: jsonSchema(bookingQuoteInputSchema), output: jsonSchema(responseSchema(bookingQuoteResultSchema)) },
  search: { kind: 'direct', request: 'body', input: jsonSchema(bookingSearchInputSchema), output: jsonSchema(responseSchema(z.object({ items: bookingSearchResultSchema }).strict())) },
  create: { kind: 'direct', request: 'body', input: jsonSchema(createBookingReservationInputSchema), output: jsonSchema(responseSchema(createResponseSchema)) },
  payment: { kind: 'direct', request: 'body', input: jsonSchema(paymentBodySchema), output: jsonSchema(responseSchema(paymentResponseSchema)) },
} as const satisfies Record<string, DirectHttpContract>;

/**
 * Explicit Booking public surface.  This controller intentionally does not use
 * the generic BusController: each route limits the operation and public DTO
 * itself, and the only elevated actor has exactly those public permissions.
 */
@Anonymous()
@Controller('api/v1/booking')
export class BookingPublicController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Get('property')
  @HttpContract(routes.property)
  async property(@Req() request: AuthenticatedRequest) {
    return ok({ property: await this.query('booking.property.getPublicProperty', {}, request) });
  }

  @Get('room-types')
  @HttpContract(routes.roomTypes)
  async roomTypes(@Req() request: AuthenticatedRequest) {
    return ok({ items: await this.query('booking.property.listActiveRoomTypes', {}, request) });
  }

  @Get('room-types/:roomTypeId')
  @HttpContract(routes.roomType)
  async roomType(@Req() request: AuthenticatedRequest, @Param(new SchemaPipe(roomTypeParamsSchema)) params: z.infer<typeof roomTypeParamsSchema>) {
    const roomType = await this.query('booking.property.getActiveRoomType', params, request);
    if (roomType === null) throw PlatformError.notFound('Booking room type', params.roomTypeId);
    return ok({ roomType });
  }

  @Post('quotes')
  @HttpContract(routes.quote)
  async quote(@Req() request: AuthenticatedRequest, @Body(new SchemaPipe(bookingQuoteInputSchema)) input: z.infer<typeof bookingQuoteInputSchema>) {
    return ok(await this.query('booking.availability.getQuote', input, request));
  }

  @Post('quotes/search')
  @HttpContract(routes.search)
  async search(@Req() request: AuthenticatedRequest, @Body(new SchemaPipe(bookingSearchInputSchema)) input: z.infer<typeof bookingSearchInputSchema>) {
    return ok({ items: await this.query('booking.availability.searchQuotes', input, request) });
  }

  @Post('reservations')
  @HttpContract(routes.create)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(createBookingReservationInputSchema)) input: z.infer<typeof createBookingReservationInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Reservation creation may return a bearer, but all create outcomes are
    // sensitive booking state and must not be retained by browsers or proxies.
    reply.header('cache-control', 'no-store');
    const result = await this.command<{
      kind: 'created' | 'stale' | 'unavailable';
      reservation?: { id: string; status: 'pending_payment'; paymentExpiresAt: string; quote: unknown };
      replacementQuote?: unknown;
    }>('booking.reservation.create', input, request, reply);
    if (result.kind === 'stale') {
      reply.code(409);
      return ok({ kind: 'stale' as const, replacementQuote: result.replacementQuote });
    }
    if (result.kind === 'unavailable') {
      reply.code(409);
      return ok({ kind: 'unavailable' as const });
    }
    const reservation = result.reservation;
    if (!reservation) throw new Error('Created Booking Reservation had no public projection');
    // This deliberately happens after CommandBus has committed its durable,
    // bearer-free response.  Deterministic presentation also makes replay safe.
    const credential = await this.runtime.database.transaction(tx => this.checkout().present(tx, reservation.id));
    return ok({ kind: 'created' as const, reservation: { id: reservation.id, status: reservation.status, paymentExpiresAt: reservation.paymentExpiresAt }, checkoutCredential: credential.credential,
      checkoutCredentialExpiresAt: credential.expiresAt.toISOString() });
  }

  @Post('reservations/:reservationId/payments')
  @HttpCode(202)
  @HttpContract(routes.payment)
  async payment(
    @Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Body(new SchemaPipe(paymentBodySchema)) input: z.infer<typeof paymentBodySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const credential = request.headers['x-booking-checkout-credential'];
    // Never let parser/length distinctions turn this opaque capability into an
    // authorization oracle.  The Reservation transaction compares the digest.
    const checkoutCredential = typeof credential === 'string' && credential.length <= 256 ? credential : '';
    const result = await this.command<{ attempt: { id: string; status: string; expiresAt: string } }>(
      'booking.reservation.startPayment', { reservationId: params.reservationId, method: input.method, checkoutCredential }, request, reply,
      tx => this.checkout().authorizePayment(tx, params.reservationId, checkoutCredential).then(() => undefined),
    );
    return ok({ attemptId: result.attempt.id, status: result.attempt.status, expiresAt: result.attempt.expiresAt });
  }

  private checkout() {
    if (!this.runtime.keyring) throw new Error('Booking public checkout requires a configured signing Keyring');
    return createBookingReservationCheckoutAccess(this.runtime.keyring);
  }

  private command<T>(
    name: string,
    input: unknown,
    request: AuthenticatedRequest,
    reply: FastifyReply,
    beforeIdempotency?: (tx: Tx) => Promise<void>,
  ): Promise<T> {
    const callerKey = this.publicIdempotencyKey(request);
    const actor = this.clientActor(request, reply);
    return this.runtime.commands.execute<T>(name, input, {
      actor, idempotencyKey: `booking-public:${sha256Hex(`${actor.id}\n${callerKey}`)}`,
      beforeIdempotency, correlationId: correlationIdOf(request), channel: 'rest',
    });
  }

  private publicIdempotencyKey(request: AuthenticatedRequest): string {
    const raw = request.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = idempotencyKeySchema.safeParse(value?.trim());
    if (!parsed.success) throw PlatformError.validation('Idempotency-Key must be a canonical UUIDv4');
    return parsed.data;
  }

  private clientActor(request: AuthenticatedRequest, reply: FastifyReply): Actor {
    const candidate = readCookie(request.cookies, BOOKING_PUBLIC_CLIENT_COOKIE, this.runtime.config.http.publicUrl);
    const clientId = idempotencyKeySchema.safeParse(candidate).success ? candidate! : randomUUID();
    if (clientId !== candidate) {
      const cookie = hostCookie(BOOKING_PUBLIC_CLIENT_COOKIE, this.runtime.config.http.publicUrl, { httpOnly: true, sameSite: 'lax' });
      reply.setCookie(cookie.name, clientId, cookie.options);
    }
    return { id: `http:booking-public:${clientId}`, type: 'service', displayName: 'Booking public HTTP', permissions: bookingPublicPermissions };
  }

  private query<T>(name: string, input: unknown, request: AuthenticatedRequest): Promise<T> {
    return this.runtime.queries.execute<T>(name, input, {
      actor: { id: 'http:booking-public-read', type: 'service', displayName: 'Booking public HTTP', permissions: bookingPublicPermissions }, correlationId: correlationIdOf(request), channel: 'rest',
    });
  }
}
