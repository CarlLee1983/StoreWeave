export type ApiEnvelope<T> =
  | { success: true; data: T; meta?: Record<string, unknown> }
  | { success: false; error: { code: string; message: string } };

export function ok<T>(data: T, meta?: Record<string, unknown>): ApiEnvelope<T> {
  return meta ? { success: true, data, meta } : { success: true, data };
}
