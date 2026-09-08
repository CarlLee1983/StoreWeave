import type { BaseConfig } from '@storeweave/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { CorsPreflightHttpRoute } from './contract';

type FastifyCorsOptions = NonNullable<Parameters<NestFastifyApplication['enableCors']>[0]>;
export type ReleaseCorsOptions = FastifyCorsOptions & {
  origin: string[];
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  preflight: true;
  strictPreflight: true;
  preflightContinue: false;
  optionsSuccessStatus: 204;
  hideOptionsRoute: false;
};

/** The one CORS policy object feeds Fastify and the startup route catalog. */
export function releaseCorsOptions(cors: BaseConfig['http']['cors']): ReleaseCorsOptions | undefined {
  if (cors.allowedOrigins.length === 0) return undefined;
  return {
    origin: cors.allowedOrigins,
    credentials: cors.credentials,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-CSRF-Token', 'X-Correlation-Id'],
    exposedHeaders: ['Retry-After'],
    preflight: true,
    strictPreflight: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
    hideOptionsRoute: false,
  };
}

export function corsPreflightRoute(options: ReleaseCorsOptions): CorsPreflightHttpRoute {
  return {
    method: 'OPTIONS', path: '*', kind: 'cors-preflight', automaticRoute: true, auth: 'unauthenticated', request: 'headers',
    requestHeaders: { origin: 'required', accessControlRequestMethod: 'required', accessControlRequestHeaders: 'optional' },
    policy: {
      allowedOrigins: options.origin, credentials: options.credentials, methods: options.methods,
      allowedHeaders: options.allowedHeaders, exposedHeaders: options.exposedHeaders,
    },
    responses: {
      allowed: { status: options.optionsSuccessStatus, accessControlAllowOrigin: 'exact-origin', accessControlAllowCredentials: options.credentials },
      denied: { status: options.optionsSuccessStatus, accessControlAllowOrigin: false, accessControlAllowCredentials: options.credentials },
      invalid: { status: 400, contentType: 'text/plain; charset=utf-8', body: 'Invalid Preflight Request' },
    },
  };
}
