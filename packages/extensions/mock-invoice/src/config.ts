import { z } from 'zod';
export const mockInvoiceConfig = z.object({ issue: z.boolean().default(true), void: z.boolean().default(true), validLoveCodes: z.array(z.string().regex(/^\d{3,7}$/)).default(['168001']) }).strict();
export type MockInvoiceConfig = z.infer<typeof mockInvoiceConfig>;
