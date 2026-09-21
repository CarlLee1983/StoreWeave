import { PlatformError, defineCommand, defineQuery, type Actor, type CommandContext, type QueryContext, type Tx } from '@storeweave/contracts';
import type { BookingReservationAccess } from './access';
import { BookingReservationRepository, type ManagedReservationDetails } from './repository';
import type { BookingReservationRow } from './schema';
import {
  claimBookingReservationInputSchema,
  claimBookingReservationOutputSchema,
  getOwnedBookingReservationInputSchema,
  getOwnedBookingReservationOutputSchema,
  getManagedBookingReservationInputSchema,
  getManagedBookingReservationOutputSchema,
  updateBookingReservationDetailsInputSchema,
  updateBookingReservationDetailsOutputSchema,
} from './types';

const repository = new BookingReservationRepository();
const accountActorId = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function unauthenticated(): PlatformError {
  return new PlatformError('UNAUTHENTICATED', 'A current Account identity and valid Reservation management access are required');
}

function accountIdFromActor(actor: Actor): string {
  if (actor.type !== 'user' && actor.type !== 'customer') throw unauthenticated();
  const match = accountActorId.exec(actor.id);
  if (!match) throw unauthenticated();
  return match[1]!;
}

function invalidManagementAccess(): PlatformError {
  return new PlatformError('UNAUTHENTICATED', 'Reservation access is invalid or has expired');
}

function ownedReservationNotFound(): PlatformError {
  return PlatformError.notFound('Reservation');
}

export const claimBookingReservationCommand = defineCommand({
  name: 'booking.reservation.claim',
  summary: '明確連結 Reservation 與已登入 Account',
  input: claimBookingReservationInputSchema,
  output: claimBookingReservationOutputSchema,
  permission: 'booking-reservation:claim',
  idempotency: 'required',
});

export function createClaimBookingReservationHandler(access: BookingReservationAccess) {
  return async (input: typeof claimBookingReservationInputSchema._output, context: CommandContext) => {
    const accountId = accountIdFromActor(context.actor);
    const authorized = await access.authorizeManagement(context.tx, {
      reservationId: input.reservationId,
      managementCredential: input.managementCredential,
    });
    if (authorized.reservationId !== input.reservationId) throw invalidManagementAccess();

    const result = await repository.claimAccount(context.tx, input.reservationId, accountId);
    if (result === 'not-found') throw ownedReservationNotFound();
    if (result === 'owned-by-another') {
      throw PlatformError.conflict('Reservation has already been claimed by another Account');
    }
    if (result === 'anonymized') {
      throw PlatformError.conflict('Reservation personal data has been anonymized');
    }
    if (result === 'claimed') {
      await context.audit({
        action: 'booking.reservation.claimed',
        resourceType: 'booking_reservation',
        resourceId: input.reservationId,
        payload: { proof: 'management-access' },
      });
    }
    return { reservationId: input.reservationId, kind: result };
  };
}

export const getOwnedBookingReservationQuery = defineQuery({
  name: 'booking.reservation.getOwned',
  summary: '讀取登入 Account 擁有的 Reservation',
  input: getOwnedBookingReservationInputSchema,
  output: getOwnedBookingReservationOutputSchema,
  permission: 'booking-reservation:read-self',
});

function managedReservationDto(row: BookingReservationRow) {
  return {
    id: row.id,
    status: row.status,
    paymentExpiresAt: row.paymentExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    booker: { name: row.bookerName, email: row.bookerEmail, phone: row.bookerPhone },
    primaryGuestName: row.primaryGuestName,
    accommodationNotes: row.accommodationNotes,
    quote: {
      roomTypeId: row.roomTypeId,
      checkInLocalDate: row.checkInLocalDate,
      checkOutLocalDate: row.checkOutLocalDate,
      adults: row.adults,
      children: row.children,
      roomCount: row.roomCount,
      currency: row.currency,
      nights: row.nightlyPrices,
      totalMinor: row.totalMinor,
      cancellationPolicy: row.cancellationPolicy,
      fingerprint: row.quoteFingerprint,
    },
  };
}

export async function getOwnedBookingReservationHandler(input: typeof getOwnedBookingReservationInputSchema._output, context: QueryContext) {
  const accountId = accountIdFromActor(context.actor);
  const row = await repository.findOwnedById(context.db, input.reservationId, accountId);
  if (!row) throw ownedReservationNotFound();
  return { reservation: managedReservationDto(row) };
}

export const getManagedBookingReservationQuery = defineQuery({
  name: 'booking.reservation.getManaged',
  summary: '以有效管理工作階段讀取 Reservation',
  input: getManagedBookingReservationInputSchema,
  output: getManagedBookingReservationOutputSchema,
  permission: 'booking-reservation:read-managed',
});

export function createGetManagedBookingReservationHandler(access: BookingReservationAccess) {
  return async (input: typeof getManagedBookingReservationInputSchema._output, context: QueryContext) => {
    const row = await context.db.transaction(async rawTx => {
      const tx = rawTx as unknown as Tx;
      const authorized = await access.authorizeManagement(tx, {
        reservationId: input.reservationId,
        managementCredential: input.managementCredential,
      });
      if (authorized.reservationId !== input.reservationId) throw invalidManagementAccess();
      return repository.findById(tx, input.reservationId);
    });
    if (!row) throw ownedReservationNotFound();
    return { reservation: managedReservationDto(row) };
  };
}

export const updateBookingReservationDetailsCommand = defineCommand({
  name: 'booking.reservation.updateManagedDetails',
  summary: '更新已授權 Booker 聯絡與入住人資料',
  input: updateBookingReservationDetailsInputSchema,
  output: updateBookingReservationDetailsOutputSchema,
  permission: 'booking-reservation:manage-self',
  idempotency: 'required',
});

function managedDetails(input: typeof updateBookingReservationDetailsInputSchema._output): {
  values: ManagedReservationDetails;
  fields: Array<'booker' | 'primaryGuestName' | 'accommodationNotes'>;
} {
  const values: ManagedReservationDetails = {};
  const fields: Array<'booker' | 'primaryGuestName' | 'accommodationNotes'> = [];
  if (input.booker) {
    values.bookerName = input.booker.name;
    values.bookerEmail = input.booker.email;
    values.bookerPhone = input.booker.phone;
    fields.push('booker');
  }
  if (input.primaryGuestName !== undefined) {
    values.primaryGuestName = input.primaryGuestName;
    fields.push('primaryGuestName');
  }
  if (input.accommodationNotes !== undefined) {
    values.accommodationNotes = input.accommodationNotes;
    fields.push('accommodationNotes');
  }
  return { values, fields };
}

export function createUpdateBookingReservationDetailsHandler(access: BookingReservationAccess) {
  return async (input: typeof updateBookingReservationDetailsInputSchema._output, context: CommandContext) => {
    const { values, fields } = managedDetails(input);
    let authorization: 'account-owner' | 'management-credential';
    let updated: boolean;

    if (input.managementCredential !== undefined) {
      const authorized = await access.authorizeManagement(context.tx, {
        reservationId: input.reservationId,
        managementCredential: input.managementCredential,
      });
      if (authorized.reservationId !== input.reservationId) throw invalidManagementAccess();
      updated = await repository.updateManagedDetails(context.tx, input.reservationId, values);
      authorization = 'management-credential';
    } else {
      const accountId = accountIdFromActor(context.actor);
      updated = await repository.updateOwnedDetails(context.tx, input.reservationId, accountId, values);
      authorization = 'account-owner';
    }

    if (!updated) throw ownedReservationNotFound();
    await context.audit({
      action: 'booking.reservation.managed-details-updated',
      resourceType: 'booking_reservation',
      resourceId: input.reservationId,
      payload: { accessMethod: authorization, changedFields: fields },
    });
    return { reservationId: input.reservationId, updatedFields: fields };
  };
}
