import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, type Actor, type Tx } from '@storeweave/contracts';
import { sha256Hex } from '@storeweave/crypto';
import {
  authorizeResendBookingReservationAccessGrant,
  bookerInputSchema,
  cancelBookingReservationSelfOutputSchema,
  claimBookingReservationOutputSchema,
  createBookingReservationAccess,
  getManagedBookingReservationOutputSchema,
  resendBookingReservationAccessGrantOutputSchema,
  updateBookingReservationDetailsOutputSchema,
} from '@storeweave/booking-reservation';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Anonymous, correlationIdOf, Public, type AuthenticatedRequest } from '../http/auth';
import { BOOKING_RESERVATION_MANAGEMENT_COOKIE, hostCookie, readCookie } from '../http/cookie-names';
import { HttpContract, type DirectHttpContract, type RawHttpContract } from '../http/contract';
import { ok } from '../http/envelope';
import { RUNTIME, type Runtime } from '../tokens';
import { SchemaPipe } from '../http/validation';

const managementPermissions = {
  claim: 'booking-reservation:claim',
  readOwned: 'booking-reservation:read-self',
  readManaged: 'booking-reservation:read-managed',
  manage: 'booking-reservation:manage-self',
} as const;

const reservationParamsSchema = z.object({ reservationId: z.string().uuid() }).strict();
const redeemQuerySchema = z.object({ grantToken: z.string().min(1).max(4096) }).strict();
const idempotencyKeySchema = z.string().uuid().refine(value => value[14] === '4' && ['8', '9', 'a', 'b'].includes(value[19] ?? ''), 'Expected UUIDv4');
const updateBodySchema = z.object({
  booker: bookerInputSchema.optional(),
  primaryGuestName: z.string().trim().min(1).max(160).optional(),
  accommodationNotes: z.string().trim().max(2000).nullable().optional(),
}).strict().refine(
  input => input.booker !== undefined || input.primaryGuestName !== undefined || input.accommodationNotes !== undefined,
  'At least one Booker, Guest, or notes field must be updated',
);
const emptyInputSchema = z.object({}).strict();
const responseSchema = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data }).strict();
const jsonSchema = (schema: z.ZodTypeAny) => zodToJsonSchema(schema as never, { target: 'jsonSchema7' });

const routes = {
  redeem: { kind: 'raw', request: 'none', statuses: [303], rateLimit: 'auth', output: { type: 'null' } },
  get: { kind: 'direct', request: 'none', rateLimit: 'auth', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(getManagedBookingReservationOutputSchema)) },
  update: { kind: 'direct', request: 'body', rateLimit: 'auth', input: jsonSchema(updateBodySchema), output: jsonSchema(responseSchema(updateBookingReservationDetailsOutputSchema)) },
  cancel: { kind: 'direct', request: 'none', rateLimit: 'auth', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(cancelBookingReservationSelfOutputSchema)) },
  resend: { kind: 'direct', request: 'none', rateLimit: 'auth', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(resendBookingReservationAccessGrantOutputSchema)) },
  claim: { kind: 'direct', request: 'none', auth: 'session', rateLimit: 'auth', input: jsonSchema(emptyInputSchema), output: jsonSchema(responseSchema(claimBookingReservationOutputSchema)) },
} as const satisfies Record<string, DirectHttpContract | RawHttpContract>;

type ManagementAuthorization = { actor: Actor; managementCredential?: string };

/**
 * Explicit browser-only Reservation management surface. Credentials never come
 * from request JSON: anonymous Booker authority is the secure cookie, while an
 * Account is identified only by its resolved session Actor.
 */
@Controller('api/v1/booking/management')
export class BookingManagementController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  /** Access Grants are one-use URL material and may only become a cookie. */
  @Anonymous()
  @Get(':reservationId/grants')
  @HttpContract(routes.redeem)
  async redeem(
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Query(new SchemaPipe(redeemQuerySchema)) query: z.infer<typeof redeemQuerySchema>,
    @Res() reply: FastifyReply,
  ) {
    const managementCredential = await this.runtime.database.transaction(async tx => {
      const redeemed = await this.access().redeemGrant(tx, { grantToken: query.grantToken });
      // Keep this check in the redemption transaction: a valid Grant addressed
      // at another URL must roll back rather than consume the Grant.
      await this.access().authorizeManagement(tx, { reservationId: params.reservationId, managementCredential: redeemed.managementCredential });
      return redeemed.managementCredential;
    });
    const cookie = hostCookie(BOOKING_RESERVATION_MANAGEMENT_COOKIE, this.runtime.config.http.publicUrl, {
      httpOnly: true, sameSite: 'strict',
    });
    reply.header('cache-control', 'no-store');
    reply.setCookie(cookie.name, managementCredential, cookie.options);
    void reply.redirect(`/api/v1/booking/management/${params.reservationId}`, 303);
  }

  @Public()
  @Get(':reservationId')
  @HttpContract(routes.get)
  async get(
    @Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const authorization = await this.authorization(request, params.reservationId, managementPermissions.readOwned);
    const result = authorization.managementCredential
      ? await this.query('booking.reservation.getManaged', { reservationId: params.reservationId, managementCredential: authorization.managementCredential }, authorization.actor, request)
      : await this.query('booking.reservation.getOwned', { reservationId: params.reservationId }, authorization.actor, request);
    return ok(result);
  }

  @Public()
  @Patch(':reservationId')
  @HttpCode(200)
  @HttpContract(routes.update)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Body(new SchemaPipe(updateBodySchema)) body: z.infer<typeof updateBodySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const authorization = await this.authorization(request, params.reservationId, managementPermissions.manage);
    const result = await this.command('booking.reservation.updateManagedDetails', {
      reservationId: params.reservationId, ...body,
      ...(authorization.managementCredential ? { managementCredential: authorization.managementCredential } : {}),
    }, authorization, request, tx => this.reauthorize(tx, params.reservationId, authorization));
    return ok(result);
  }

  @Public()
  @Post(':reservationId/cancel')
  @HttpCode(200)
  @HttpContract(routes.cancel)
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const authorization = await this.authorization(request, params.reservationId, managementPermissions.manage);
    const result = await this.command('booking.reservation.cancelSelf', {
      reservationId: params.reservationId,
      ...(authorization.managementCredential ? { managementCredential: authorization.managementCredential } : {}),
    }, authorization, request, tx => this.reauthorize(tx, params.reservationId, authorization));
    return ok(result);
  }

  @Public()
  @Post(':reservationId/resend-access-grant')
  @HttpCode(200)
  @HttpContract(routes.resend)
  async resend(
    @Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const authorization = await this.authorization(request, params.reservationId, managementPermissions.manage);
    const input = {
      reservationId: params.reservationId,
      ...(authorization.managementCredential ? { managementCredential: authorization.managementCredential } : {}),
    };
    const result = await this.command('booking.reservation.resendAccessGrant', input, authorization, request,
      tx => authorizeResendBookingReservationAccessGrant(tx, authorization.actor, input, this.access()).then(() => undefined));
    return ok(result);
  }

  /** Claim requires a fresh Account session plus an existing management session. */
  @Post(':reservationId/claim')
  @HttpCode(200)
  @HttpContract(routes.claim)
  async claim(
    @Req() request: AuthenticatedRequest,
    @Param(new SchemaPipe(reservationParamsSchema)) params: z.infer<typeof reservationParamsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const managementCredential = this.managementCredential(request);
    if (managementCredential === undefined) throw this.invalidManagementAccess();
    const authorization = { actor: this.accountActor(request, managementPermissions.claim), managementCredential };
    const result = await this.command('booking.reservation.claim', {
      reservationId: params.reservationId, managementCredential,
    }, authorization, request, tx => this.access().authorizeManagement(tx, { reservationId: params.reservationId, managementCredential }).then(() => undefined));
    return ok(result);
  }

  private async authorization(request: AuthenticatedRequest, reservationId: string, accountPermission: string): Promise<ManagementAuthorization> {
    const account = this.currentAccountActor(request, accountPermission);
    const ownerProbe = this.currentAccountActor(request, managementPermissions.readOwned);
    const managementCredential = this.managementCredential(request);
    if (account && ownerProbe) {
      try {
        // An owner must not lose access merely because the browser retained a
        // stale management cookie after a resend. This has no authority effect:
        // the owner query remains the canonical Reservation ownership check.
        await this.query('booking.reservation.getOwned', { reservationId }, ownerProbe, request);
        return { actor: account };
      } catch (error) {
        if (!(error instanceof PlatformError) || error.code !== 'NOT_FOUND') throw error;
        // A signed-in non-owner may still be the authorized Booker. Fall
        // through to the management capability rather than treating Account
        // presence itself as a denial.
      }
    }
    if (managementCredential !== undefined) {
      return { managementCredential, actor: this.managementActor(managementCredential, accountPermission === managementPermissions.readOwned
        ? managementPermissions.readManaged : managementPermissions.manage) };
    }
    return { actor: account ?? this.accountActor(request, accountPermission) };
  }

  private managementCredential(request: AuthenticatedRequest): string | undefined {
    const credential = readCookie(request.cookies, BOOKING_RESERVATION_MANAGEMENT_COOKIE, this.runtime.config.http.publicUrl);
    // Malformed cookie material remains an authorization failure, rather than a
    // parser oracle. The Reservation capability compares the credential digest.
    return credential === undefined ? undefined : credential.length <= 128 ? credential : '';
  }

  private accountActor(request: AuthenticatedRequest, permission: string): Actor {
    const actor = this.currentAccountActor(request, permission);
    if (!actor) {
      throw new PlatformError('UNAUTHENTICATED', 'A current Account identity is required');
    }
    return actor;
  }

  private currentAccountActor(request: AuthenticatedRequest, permission: string): Actor | undefined {
    const actor = request.actor;
    if (!actor || (actor.type !== 'user' && actor.type !== 'customer')) {
      return undefined;
    }
    // Booking management is a precise adapter boundary. Retain the authenticated
    // Account identity but grant only the descriptor permission whose handler
    // performs canonical owner filtering.
    return { id: actor.id, type: actor.type, displayName: actor.displayName, permissions: [permission] };
  }

  private managementActor(credential: string, permission: string): Actor {
    return {
      // Never put bearer material in CommandBus/audit logs or idempotency rows.
      id: `http:booking-management:${sha256Hex(credential)}`,
      type: 'service', displayName: 'Booking management HTTP', permissions: [permission],
    };
  }

  private access() {
    if (!this.runtime.keyring) throw new Error('Booking management requires a configured signing Keyring');
    return createBookingReservationAccess(this.runtime.keyring);
  }

  private command<T>(
    name: string,
    input: unknown,
    authorization: ManagementAuthorization,
    request: AuthenticatedRequest,
    beforeIdempotency?: (tx: Tx) => Promise<void>,
  ): Promise<T> {
    const callerKey = this.idempotencyKey(request);
    return this.runtime.commands.execute<T>(name, input, {
      actor: authorization.actor,
      idempotencyKey: `booking-management:${sha256Hex(`${authorization.actor.id}\n${callerKey}`)}`,
      beforeIdempotency,
      correlationId: correlationIdOf(request), channel: 'rest',
    });
  }

  private query<T>(name: string, input: unknown, actor: Actor, request: AuthenticatedRequest): Promise<T> {
    return this.runtime.queries.execute<T>(name, input, { actor, correlationId: correlationIdOf(request), channel: 'rest' });
  }

  private idempotencyKey(request: AuthenticatedRequest): string {
    const raw = request.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = idempotencyKeySchema.safeParse(value?.trim());
    if (!parsed.success) throw PlatformError.validation('Idempotency-Key must be a canonical UUIDv4');
    return parsed.data;
  }

  private invalidManagementAccess(): PlatformError {
    return new PlatformError('UNAUTHENTICATED', 'Reservation access is invalid or has expired');
  }

  private reauthorize(tx: Tx, reservationId: string, authorization: ManagementAuthorization): Promise<void> {
    if (authorization.managementCredential !== undefined) {
      return this.access().authorizeManagement(tx, { reservationId, managementCredential: authorization.managementCredential }).then(() => undefined);
    }
    return authorizeResendBookingReservationAccessGrant(tx, authorization.actor, { reservationId }, this.access()).then(() => undefined);
  }
}
