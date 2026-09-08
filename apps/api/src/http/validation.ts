import type { PipeTransform } from '@nestjs/common';
import { PlatformError, type Schema } from '@storeweave/contracts';

/** Direct HTTP services use the same validation error envelope as the buses. */
export class SchemaPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: Schema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw PlatformError.validation('Invalid request input', parsed.error.issues);
    return parsed.data;
  }
}
