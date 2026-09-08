import { HTTP_ADAPTER, type ReleaseHttpAdapter } from './release-adapter';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiTokenGuard } from './http/auth';
import { PlatformExceptionFilter } from './http/exception.filter';
import { RELEASE, RUNTIME, THEME, type ReleaseInfo, type Runtime, type StorefrontTheme } from './tokens';

@Module({})
export class AppModule {
  static forRuntime(
    runtime: Runtime,
    theme: StorefrontTheme | undefined,
    release: ReleaseInfo,
    http: ReleaseHttpAdapter,
    controllers: readonly Type[],
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [...controllers],
      providers: [
        { provide: HTTP_ADAPTER, useValue: http },
        { provide: RUNTIME, useValue: runtime },
        { provide: THEME, useValue: theme },
        { provide: RELEASE, useValue: release },
        { provide: APP_GUARD, useClass: ApiTokenGuard },
        { provide: APP_FILTER, useClass: PlatformExceptionFilter },
      ],
    };
  }
}
