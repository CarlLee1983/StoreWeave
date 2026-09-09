import type { ReleaseHttpAdapter } from '../release-adapter';
import { setSessionCookies } from '../http/session-cookies';
import { AuthController } from '../controllers/auth.controller';
import { ExtensionsController } from '../controllers/extensions.controller';
import { HealthController } from '../controllers/health.controller';
import { MetaController } from '../controllers/meta.controller';
import { SystemController } from '../controllers/system.controller';
import { StorageController } from '../controllers/storage.controller';

export const httpAdapter: ReleaseHttpAdapter = {
  releaseId: 'base', anonymousRole: null,
  controllers: () => [HealthController, MetaController, AuthController, SystemController, StorageController, ExtensionsController],
  async startSession(runtime, _request, reply, session) {
    setSessionCookies(reply, {
      publicUrl: runtime.config.http.publicUrl, token: session.token, expiresAt: session.expiresAt,
    });
    return null;
  },
};
