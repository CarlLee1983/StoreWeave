import { z } from 'zod';

const currencyCodes = new Set(Intl.supportedValuesOf('currency'));

export const propertyAddressSchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  postalCode: z.string().trim().max(24).nullable(),
  administrativeArea: z.string().trim().min(1).max(120),
  locality: z.string().trim().min(1).max(120),
  addressLine1: z.string().trim().min(1).max(240),
  addressLine2: z.string().trim().max(240).nullable(),
}).strict();

export const propertyDefaultPolicySchema = z.object({
  freeCancellationHoursBeforeCheckIn: z.number().int().min(0).max(8760),
}).strict();

export const bedSchema = z.object({
  type: z.enum(['single', 'double', 'queen', 'king', 'sofa-bed', 'bunk', 'other']),
  count: z.number().int().min(1).max(8),
}).strict();

export const amenitySchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  label: z.string().trim().min(1).max(100),
}).strict();

export const checkInTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const currencySchema = z.string().refine(code => currencyCodes.has(code), 'Expected a supported ISO 4217 currency code');
export const timezoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Expected a valid IANA time zone');

export const propertyInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  address: propertyAddressSchema,
  timezone: timezoneSchema,
  currency: currencySchema,
  checkInTime: checkInTimeSchema,
  checkOutTime: checkInTimeSchema,
  defaultPolicy: propertyDefaultPolicySchema,
}).strict().superRefine((property, context) => {
  if (property.checkInTime === property.checkOutTime) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOutTime'], message: 'Check-in and check-out times must differ' });
  }
});

const roomTypeFactsObject = z.object({
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,49}$/),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable(),
  maxOccupancyPerUnit: z.number().int().min(1).max(32),
  beds: z.array(bedSchema).max(8),
  amenities: z.array(amenitySchema).max(50),
  minimumStayNights: z.number().int().min(1).max(30),
  maximumStayNights: z.number().int().min(1).max(30).nullable(),
  mediaAssetId: z.string().uuid().nullable(),
}).strict();

type RoomTypeRuleFacts = Pick<z.infer<typeof roomTypeFactsObject>, 'minimumStayNights' | 'maximumStayNights' | 'amenities'>;

function validateRoomTypeFacts(roomType: RoomTypeRuleFacts, context: z.RefinementCtx): void {
  if (roomType.maximumStayNights !== null && roomType.minimumStayNights > roomType.maximumStayNights) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['maximumStayNights'], message: 'Maximum stay must be at least the minimum stay' });
  }
  const codes = roomType.amenities.map(item => item.code);
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['amenities'], message: 'Amenity codes must be unique' });
  }
}

export const roomTypeFactsSchema = roomTypeFactsObject.superRefine(validateRoomTypeFacts);

export const createRoomTypeInputSchema = roomTypeFactsSchema;
export const updateRoomTypeInputSchema = roomTypeFactsObject.omit({ code: true }).extend({
  roomTypeId: z.string().uuid(),
  status: z.enum(['active', 'disabled']),
}).strict().superRefine(validateRoomTypeFacts);

export const propertyDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  address: propertyAddressSchema,
  timezone: timezoneSchema,
  currency: currencySchema,
  checkInTime: checkInTimeSchema,
  checkOutTime: checkInTimeSchema,
  defaultPolicy: propertyDefaultPolicySchema,
  createdAt: z.date(),
  updatedAt: z.date(),
}).strict();

export const roomTypeDtoSchema = roomTypeFactsObject.extend({
  id: z.string().uuid(),
  status: z.enum(['active', 'disabled']),
  createdAt: z.date(),
  updatedAt: z.date(),
}).strict().superRefine(validateRoomTypeFacts);

export type PropertyAddress = z.infer<typeof propertyAddressSchema>;
export type PropertyDefaultPolicy = z.infer<typeof propertyDefaultPolicySchema>;
export type RoomTypeFacts = z.infer<typeof roomTypeFactsSchema>;
export type PropertyDto = z.infer<typeof propertyDtoSchema>;
export type RoomTypeDto = z.infer<typeof roomTypeDtoSchema>;
