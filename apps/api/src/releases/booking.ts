import type { Type } from '@nestjs/common';
import type { ReleaseHttpAdapter } from '../release-adapter';
import { startSession } from '../http/session-start';
import { AuthController } from '../controllers/auth.controller';
import { BookingManagementController } from '../controllers/booking-management.controller';
import { BookingPublicController } from '../controllers/booking-public.controller';
import { BookingMediaController } from '../controllers/booking-media.controller';
import { BookingOperatorController } from '../controllers/booking-operator.controller';
import { BookingCallbackController } from '../controllers/booking-callback.controller';
import { HealthController } from '../controllers/health.controller';
import { MetaController } from '../controllers/meta.controller';

/** Booking's server projection deliberately mounts only its explicit public API. */
export const bookingHttpAdapter: ReleaseHttpAdapter = {
  releaseId: 'booking', anonymousRole: null, startSession,
  controllers(): Type[] {
    return [HealthController, MetaController, AuthController, BookingPublicController, BookingMediaController, BookingManagementController,
      BookingOperatorController, BookingCallbackController];
  },
};
