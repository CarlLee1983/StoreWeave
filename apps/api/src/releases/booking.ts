import type { Type } from '@nestjs/common';
import type { ReleaseHttpAdapter } from '../release-adapter';
import { startSession } from '../http/session-start';
import { BookingPublicController } from '../controllers/booking-public.controller';
import { HealthController } from '../controllers/health.controller';
import { MetaController } from '../controllers/meta.controller';

/** Booking's server projection deliberately mounts only its explicit public API. */
export const bookingHttpAdapter: ReleaseHttpAdapter = {
  releaseId: 'booking', anonymousRole: null, startSession,
  controllers(): Type[] {
    return [HealthController, MetaController, BookingPublicController];
  },
};
