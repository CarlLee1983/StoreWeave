export type ApiEnvelope<T> =
  | { success: true; data: T; meta?: Record<string, unknown> }
  | { success: false; error: { code: string; message: string } };

export function ok<T>(data: T, meta?: Record<string, unknown>): ApiEnvelope<T> {
  return meta ? { success: true, data, meta } : { success: true, data };
}
import { z } from 'zod';
import { HTTP_STATUS, type ErrorCode } from '@storeweave/contracts';

type HttpErrorCode = ErrorCode | 'RATE_LIMITED';
export const httpErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.enum(['RATE_LIMITED', ...(Object.keys(HTTP_STATUS) as ErrorCode[])]),
    message: z.string(),
    details: z.unknown().optional().describe('Only validation errors expose input issue details'),
  }),
});

/** Internal error details stay in logs; validation issue details are caller-safe. */
export function httpError(error: { code: HttpErrorCode; message: string; details?: unknown }): z.infer<typeof httpErrorSchema> {
  return { success: false, error: {
    code: error.code, message: error.message,
    ...(error.code === 'VALIDATION_ERROR' && error.details !== undefined ? { details: error.details } : {}),
  } };
}
