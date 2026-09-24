import { Controller, Get, Inject, Param, Post, Put, Body, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { sha256Hex } from '@storeweave/crypto';
import {
  createRoomTypeInputSchema, propertyDtoSchema, propertyInputSchema, roomTypeDtoSchema, updateRoomTypeInputSchema,
} from '@storeweave/booking-property';
import {
  availabilityAdminContextSchema, getRoomNightRangeInputSchema, roomNightRangeViewSchema, setBaseNightlyPriceInputSchema,
  setBaseNightlyPriceOutputSchema, updateRoomNightRangeInputSchema, updateRoomNightRangeOutputSchema,
} from '@storeweave/booking-availability';
import {
  cancelBookingReservationByOperatorInputSchema, cancelBookingReservationByOperatorOutputSchema,
  getOperatorBookingReservationOutputSchema, listBookingReservationNotificationsOutputSchema,
  listBookingReservationRefundsOutputSchema, listOperatorBookingPaymentAttemptsOutputSchema,
  listOperatorBookingReservationsInputSchema, listOperatorBookingReservationsOutputSchema,
  retryBookingReservationRefundInputSchema, retryBookingReservationRefundOutputSchema,
} from '@storeweave/booking-reservation';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { actorOf, correlationIdOf, idempotencyKeyOf, type AuthenticatedRequest } from '../http/auth';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { ok } from '../http/envelope';
import { SchemaPipe } from '../http/validation';
import { RUNTIME, type Runtime } from '../tokens';

const page = { limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10_000).default(0) };
const pageQuery = z.object(page).strict();
const idParams = z.object({ reservationId: z.string().uuid() }).strict();
const roomTypeParams = z.object({ roomTypeId: z.string().uuid() }).strict();
const uuidv4 = z.string().uuid().refine(value => value[14] === '4' && ['8', '9', 'a', 'b'].includes(value[19] ?? ''), 'Expected UUIDv4');
const emptyInput = z.object({}).strict();
const listReservationsQuery = z.object({
  ...page,
  status: z.enum(['pending_payment', 'confirmed', 'expired', 'cancelled']).optional(),
  roomTypeId: z.string().uuid().optional(),
  checkInFrom: z.string().optional(), checkInTo: z.string().optional(),
}).strict().pipe(listOperatorBookingReservationsInputSchema);
const response = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data }).strict();
const jsonSchema = (schema: z.ZodTypeAny) => zodToJsonSchema(schema as never, { target: 'jsonSchema7' });

const routes = {
  property: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.property.getProperty' }, request: 'none', input: jsonSchema(emptyInput), output: jsonSchema(response(z.object({ property: propertyDtoSchema.nullable() }).strict())) },
  createProperty: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.property.create' }, request: 'body', input: jsonSchema(propertyInputSchema), output: jsonSchema(response(propertyDtoSchema)) },
  updateProperty: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.property.update' }, request: 'body', input: jsonSchema(propertyInputSchema), output: jsonSchema(response(propertyDtoSchema)) },
  roomTypes: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.property.listRoomTypes' }, request: 'none', input: jsonSchema(emptyInput), output: jsonSchema(response(z.object({ items: z.array(roomTypeDtoSchema) }).strict())) },
  roomType: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.property.getRoomType' }, request: 'none', input: jsonSchema(emptyInput), output: jsonSchema(response(roomTypeDtoSchema)) },
  createRoomType: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.property.createRoomType' }, request: 'body', input: jsonSchema(createRoomTypeInputSchema), output: jsonSchema(response(roomTypeDtoSchema)) },
  updateRoomType: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.property.updateRoomType' }, request: 'body', input: jsonSchema(updateRoomTypeInputSchema), output: jsonSchema(response(roomTypeDtoSchema)) },
  availabilityContext: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.availability.getAdminContext' }, request: 'none', input: jsonSchema(emptyInput), output: jsonSchema(response(availabilityAdminContextSchema.nullable())) },
  roomNightRange: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.availability.getRoomNightRange' }, request: 'none', input: jsonSchema(getRoomNightRangeInputSchema), output: jsonSchema(response(roomNightRangeViewSchema)) },
  basePrice: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.availability.setBaseNightlyPrice' }, request: 'body', input: jsonSchema(setBaseNightlyPriceInputSchema), output: jsonSchema(response(setBaseNightlyPriceOutputSchema)) },
  updateRoomNightRange: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.availability.updateRoomNightRange' }, request: 'body', input: jsonSchema(updateRoomNightRangeInputSchema), output: jsonSchema(response(updateRoomNightRangeOutputSchema)) },
  reservations: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.reservation.listOperator' }, request: 'none', input: jsonSchema(listReservationsQuery),
    output: jsonSchema(response(listOperatorBookingReservationsOutputSchema)) },
  reservation: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.reservation.getOperator' }, request: 'none', input: jsonSchema(emptyInput), output: jsonSchema(response(getOperatorBookingReservationOutputSchema)) },
  cancelReservation: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.reservation.cancelByOperator' }, request: 'body', input: jsonSchema(cancelBookingReservationByOperatorInputSchema), output: jsonSchema(response(cancelBookingReservationByOperatorOutputSchema)) },
  paymentAttempts: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.reservation.listOperatorPaymentAttempts' }, request: 'none', input: jsonSchema(pageQuery), output: jsonSchema(response(listOperatorBookingPaymentAttemptsOutputSchema)) },
  refunds: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.reservation.listRefunds' }, request: 'none', input: jsonSchema(pageQuery), output: jsonSchema(response(listBookingReservationRefundsOutputSchema)) },
  notifications: { kind: 'direct', auth: 'session', target: { kind: 'query', name: 'booking.reservation.listNotifications' }, request: 'none', input: jsonSchema(pageQuery), output: jsonSchema(response(listBookingReservationNotificationsOutputSchema)) },
  retryRefund: { kind: 'direct', auth: 'session', target: { kind: 'command', name: 'booking.reservation.retryRefund' }, request: 'body', input: jsonSchema(retryBookingReservationRefundInputSchema), output: jsonSchema(response(retryBookingReservationRefundOutputSchema)) },
} as const satisfies Record<string, DirectHttpContract>;

/** Explicit Booking operator HTTP methods. Every invocation retains the resolved human Actor for Bus authorization. */
@Controller('api/v1/booking/operator')
export class BookingOperatorController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Get('property')
  @HttpContract(routes.property)
  async getProperty(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok({ property: await this.query('booking.property.getProperty', {}, request) });
  }

  @Post('property')
  @HttpContract(routes.createProperty)
  async createProperty(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(propertyInputSchema)) body: z.infer<typeof propertyInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.property.create', body, request, reply);
  }

  @Put('property')
  @HttpContract(routes.updateProperty)
  async updateProperty(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(propertyInputSchema)) body: z.infer<typeof propertyInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.property.update', body, request, reply);
  }

  @Get('room-types')
  @HttpContract(routes.roomTypes)
  async listRoomTypes(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok({ items: await this.query('booking.property.listRoomTypes', {}, request) });
  }

  @Get('room-types/:roomTypeId')
  @HttpContract(routes.roomType)
  async getRoomType(@Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(roomTypeParams)) params: z.infer<typeof roomTypeParams>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const result = await this.query('booking.property.getRoomType', params, request);
    if (result === null) throw PlatformError.notFound('Booking Room Type', params.roomTypeId);
    return ok(result);
  }

  @Post('room-types')
  @HttpContract(routes.createRoomType)
  async createRoomType(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(createRoomTypeInputSchema)) body: z.infer<typeof createRoomTypeInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.property.createRoomType', body, request, reply);
  }

  @Put('room-types')
  @HttpContract(routes.updateRoomType)
  async updateRoomType(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(updateRoomTypeInputSchema)) body: z.infer<typeof updateRoomTypeInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.property.updateRoomType', body, request, reply);
  }

  @Get('availability/room-night-range')
  @HttpContract(routes.roomNightRange)
  async getRoomNightRange(@Req() request: AuthenticatedRequest,
    @Query(new SchemaPipe(getRoomNightRangeInputSchema)) input: z.infer<typeof getRoomNightRangeInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const result = await this.query('booking.availability.getRoomNightRange', input, request);
    if (result === null) throw PlatformError.notFound('Booking Room Type', input.roomTypeId);
    return ok(result);
  }

  @Get('availability/context')
  @HttpContract(routes.availabilityContext)
  async getAvailabilityContext(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok(await this.query('booking.availability.getAdminContext', {}, request));
  }

  @Put('availability/base-price')
  @HttpContract(routes.basePrice)
  async setBasePrice(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(setBaseNightlyPriceInputSchema)) body: z.infer<typeof setBaseNightlyPriceInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.availability.setBaseNightlyPrice', body, request, reply);
  }

  @Put('availability/room-night-range')
  @HttpContract(routes.updateRoomNightRange)
  async updateRoomNightRange(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(updateRoomNightRangeInputSchema)) body: z.infer<typeof updateRoomNightRangeInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.availability.updateRoomNightRange', body, request, reply);
  }

  @Get('reservations')
  @HttpContract(routes.reservations)
  async listReservations(
    @Req() request: AuthenticatedRequest,
    @Query(new SchemaPipe(listReservationsQuery)) input: z.output<typeof listReservationsQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    return ok(await this.query('booking.reservation.listOperator', input, request));
  }

  @Get('reservations/:reservationId')
  @HttpContract(routes.reservation)
  async getReservation(@Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(idParams)) params: z.infer<typeof idParams>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok(await this.query('booking.reservation.getOperator', params, request));
  }

  @Post('reservations/cancel')
  @HttpContract(routes.cancelReservation)
  async cancelReservation(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(cancelBookingReservationByOperatorInputSchema)) body: z.infer<typeof cancelBookingReservationByOperatorInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.reservation.cancelByOperator', body, request, reply);
  }

  @Get('reservations/:reservationId/payment-attempts')
  @HttpContract(routes.paymentAttempts)
  async listPaymentAttempts(@Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(idParams)) params: z.infer<typeof idParams>,
    @Query(new SchemaPipe(pageQuery)) pageInput: z.output<typeof pageQuery>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok(await this.query('booking.reservation.listOperatorPaymentAttempts', { ...params, ...pageInput }, request));
  }

  @Get('reservations/:reservationId/refunds')
  @HttpContract(routes.refunds)
  async listRefunds(@Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(idParams)) params: z.infer<typeof idParams>,
    @Query(new SchemaPipe(pageQuery)) pageInput: z.output<typeof pageQuery>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok(await this.query('booking.reservation.listRefunds', { ...params, ...pageInput }, request));
  }

  @Get('reservations/:reservationId/notifications')
  @HttpContract(routes.notifications)
  async listNotifications(@Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(idParams)) params: z.infer<typeof idParams>,
    @Query(new SchemaPipe(pageQuery)) pageInput: z.output<typeof pageQuery>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return ok(await this.query('booking.reservation.listNotifications', { ...params, ...pageInput }, request));
  }

  @Post('refunds/retry')
  @HttpContract(routes.retryRefund)
  async retryRefund(@Req() request: AuthenticatedRequest,
    @Body(new SchemaPipe(retryBookingReservationRefundInputSchema)) body: z.infer<typeof retryBookingReservationRefundInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply) {
    return this.write('booking.reservation.retryRefund', body, request, reply);
  }

  private operator(request: AuthenticatedRequest): Actor {
    const actor = actorOf(request);
    if (actor.type !== 'user') throw PlatformError.forbidden('A human Booking operator is required');
    return actor;
  }

  private query<T>(name: string, input: unknown, request: AuthenticatedRequest): Promise<T> {
    return this.runtime.queries.execute<T>(name, input, {
      actor: this.operator(request), correlationId: correlationIdOf(request), channel: 'rest',
    });
  }

  private async write<T>(name: string, input: unknown, request: AuthenticatedRequest, reply: FastifyReply) {
    const actor = this.operator(request);
    const callerKey = uuidv4.safeParse(idempotencyKeyOf(request));
    if (!callerKey.success) throw PlatformError.validation('Idempotency-Key must be a canonical UUIDv4');
    reply.header('cache-control', 'no-store');
    const result = await this.runtime.commands.execute<T>(name, input, {
      actor, idempotencyKey: `booking-operator:${sha256Hex(`${name}\n${actor.id}\n${callerKey.data}`)}`,
      correlationId: correlationIdOf(request), channel: 'rest',
    });
    return ok(result);
  }
}
