import 'reflect-metadata';
import { applyDecorators, RequestMethod, SetMetadata, type Type } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RouteConfig } from '@nestjs/platform-fastify';
import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema';
import { z } from 'zod';
import { declaredInputKeys, PlatformError } from '@storeweave/contracts';
import type { ShippingProvider } from '@storeweave/extension-sdk';
import type { Runtime } from '@storeweave/kernel';
import { IS_ANONYMOUS, IS_EXTERNAL_CALLBACK, IS_PUBLIC } from './auth';
import { httpErrorSchema } from './envelope';
import { MCP_METHOD_LIST, MCP_PROTOCOL_VERSION, jsonRpcRequest } from '../mcp/jsonrpc';

export type RateLimitBucket = 'auth' | 'coupon' | 'cart' | 'callback';

export interface BusHttpContract {
  readonly kind: 'bus';
  readonly target: { readonly kind: 'command' | 'query'; readonly name: string };
  readonly request: 'body' | 'query' | 'none';
  readonly rateLimit?: RateLimitBucket;
  /** HTTP path parameter -> descriptor input field. */
  readonly params?: Readonly<Record<string, string>>;
  readonly queryEncoding?: Readonly<Record<string, 'csv' | 'number' | 'number-empty-default' | 'boolean'>>;
  /** Legacy HTTP nulls that use the descriptor's existing default. */
  readonly nullAsMissing?: readonly string[];
}

export interface ComposedHttpContract extends Omit<BusHttpContract, 'kind'> {
  readonly kind: 'composed';
  readonly injected?: readonly string[];
  readonly bodyFields?: readonly string[];
  readonly serverDefaulted?: readonly string[];
  readonly idempotencyKey?: 'request-header' | 'server-derived';
  /** The controller preserves this response shape; it is not a Bus DTO. */
  readonly output: JsonSchema7Type | 'target';
}

/** A JSON handler that is not backed by a Command/Query descriptor. */
export interface DirectHttpContract {
  readonly kind: 'direct';
  readonly request: 'body' | 'none';
  readonly rateLimit?: RateLimitBucket;
  /** A handler-level requirement stricter than the Nest guard's accepted credentials. */
  readonly auth?: 'session';
  readonly input: JsonSchema7Type;
  /** The complete successful JSON response, including any REST envelope. */
  readonly output: JsonSchema7Type;
}

/** A route that deliberately returns its own JSON shape rather than a Bus envelope. */
export interface RawHttpContract {
  readonly kind: 'raw';
  readonly request: 'none';
  readonly rateLimit?: RateLimitBucket;
  /** First status is the normal response; the rest are intentional state responses. */
  readonly statuses: readonly [number, ...number[]];
  readonly output: JsonSchema7Type;
}

export interface ExtensionCommandHttpContract {
  readonly kind: 'extension-command';
  readonly request: 'body';
  readonly rateLimit?: RateLimitBucket;
}

export interface ExtensionQueryHttpContract {
  readonly kind: 'extension-query';
  readonly request: 'query';
  readonly rateLimit?: RateLimitBucket;
  readonly queryExtras: 'drop-and-log-keys';
}

export interface McpHttpContract {
  readonly kind: 'mcp';
  readonly transport: 'direct' | 'jsonrpc';
  readonly request: 'none' | 'body';
  readonly rateLimit?: RateLimitBucket;
}

/** A provider-owned acknowledgement over an unmodified, bounded HTTP request. */
export interface ProviderCallbackHttpContract {
  readonly kind: 'provider-callback';
  readonly request: 'raw';
  readonly providerKinds: readonly ['payment', 'shipping'];
  readonly rateLimit: 'callback';
}

/**
 * Storefront handlers render Theme HTML or perform browser redirects.  They do
 * not have a Bus/REST envelope to describe.
 */
export interface StorefrontHttpContract {
  readonly kind: 'storefront';
  readonly request: 'none' | 'query' | 'form';
  readonly rateLimit?: RateLimitBucket;
  readonly input: JsonSchema7Type;
  /** HTTP path parameter -> documented caller input name. */
  readonly params?: Readonly<Record<string, string>>;
  /** The handler redirects non-customers; this is not a guard requirement. */
  readonly audience?: 'customer';
  /** An external picker callback is authorized by its opaque token, not a session. */
  readonly auth?: 'opaque-capability';
  readonly responses: readonly StorefrontResponse[];
  readonly cookieEffects?: readonly StorefrontCookieEffect[];
}

export type StorefrontResponse =
  | { readonly kind: 'html'; readonly status: number | 'platform-error'; readonly contentType: 'text/html; charset=utf-8'; readonly body: 'theme' }
  | { readonly kind: 'redirect'; readonly status: 303; readonly location:
    | { readonly kind: 'fixed'; readonly value: string }
    | { readonly kind: 'server-constructed' }
    | { readonly kind: 'validated-same-origin' } };
export type StorefrontCookieEffect = 'session-start' | 'session-clear' | 'guest-cart-ensure' | 'cart-notice-consume';

/** The small release-owned artwork fallback is binary, unlike Theme pages. */
export interface StorefrontAssetHttpContract {
  readonly kind: 'storefront-asset';
  readonly request: 'none';
  readonly input: JsonSchema7Type;
  readonly params: Readonly<Record<string, string>>;
  readonly allowedFiles: readonly string[];
}

export type ExtensionHttpContract = ExtensionCommandHttpContract | ExtensionQueryHttpContract;
export type HttpRouteContract = BusHttpContract | ComposedHttpContract | DirectHttpContract | RawHttpContract | ExtensionHttpContract | McpHttpContract | ProviderCallbackHttpContract | StorefrontHttpContract | StorefrontAssetHttpContract;
export type HttpRouteConfig = { readonly storeweaveContract?: HttpRouteContract };

type BusTarget = BusHttpContract['target'];
type DescribedBusRoute = {
  readonly method: string; readonly path: string; readonly status: number; readonly auth: string; readonly owner: string;
  readonly rateLimit: RateLimitBucket | null;
  readonly kind: 'bus'; readonly target: BusTarget; readonly request: BusHttpContract['request'];
  readonly params: Readonly<Record<string, string>>; readonly injected: readonly string[];
  readonly queryEncoding: Readonly<Record<string, string>>; readonly permission: unknown;
  readonly nullAsMissing: readonly string[]; readonly bodyFields: undefined; readonly serverDefaulted: readonly string[];
  readonly idempotencyKey: 'request-header'; readonly idempotency: unknown;
  readonly input: JsonSchema7Type; readonly error: JsonSchema7Type; readonly output: JsonSchema7Type;
};
type DescribedComposedRoute = Omit<DescribedBusRoute, 'kind' | 'request' | 'bodyFields' | 'idempotencyKey'> & {
  readonly kind: 'composed'; readonly request: ComposedHttpContract['request'];
  readonly bodyFields: readonly string[] | undefined; readonly idempotencyKey: 'request-header' | 'server-derived';
};
type DescribedRawRoute = {
  readonly method: string; readonly path: string; readonly status: number; readonly statuses: readonly [number, ...number[]];
  readonly rateLimit: RateLimitBucket | null;
  readonly auth: string; readonly owner: null; readonly kind: 'raw'; readonly request: 'none'; readonly permission: null;
  readonly idempotency: 'none'; readonly input: JsonSchema7Type; readonly output: JsonSchema7Type;
};
type DescribedDirectRoute = {
  readonly method: string; readonly path: string; readonly status: number; readonly auth: string; readonly owner: null;
  readonly rateLimit: RateLimitBucket | null;
  readonly kind: 'direct'; readonly request: DirectHttpContract['request']; readonly permission: null; readonly idempotency: 'none';
  readonly input: JsonSchema7Type; readonly error: JsonSchema7Type; readonly output: JsonSchema7Type;
};
type DescribedExtensionTarget = {
  readonly extensionId: string; readonly target: BusTarget; readonly owner: string; readonly permission: unknown;
  readonly idempotency: unknown; readonly input: JsonSchema7Type; readonly output: JsonSchema7Type;
};
type DescribedExtensionRoute = {
  readonly method: string; readonly path: string; readonly status: number; readonly auth: string;
  readonly rateLimit: RateLimitBucket | null;
  readonly kind: ExtensionHttpContract['kind']; readonly request: ExtensionHttpContract['request'];
  readonly queryExtras?: ExtensionQueryHttpContract['queryExtras']; readonly targets: readonly DescribedExtensionTarget[];
  readonly error: JsonSchema7Type;
};
type DescribedMcpTool = {
  readonly name: string; readonly description: string; readonly owner: string;
  readonly target: BusTarget; readonly targetOwner: string; readonly permission: unknown;
  readonly idempotencyKey: 'tool-argument' | 'none'; readonly input: JsonSchema7Type;
};
type DescribedMcpRoute = {
  readonly method: string; readonly path: string; readonly status: number; readonly auth: string;
  readonly rateLimit: RateLimitBucket | null;
  readonly kind: 'mcp'; readonly transport: McpHttpContract['transport']; readonly request: McpHttpContract['request'];
  readonly contentType: 'application/json'; readonly protocolVersion: typeof MCP_PROTOCOL_VERSION; readonly methods: readonly string[];
  readonly tools: readonly DescribedMcpTool[]; readonly input: JsonSchema7Type; readonly error: JsonSchema7Type; readonly output: JsonSchema7Type;
};
type DescribedProviderCallbackTarget = {
  readonly kind: 'payment' | 'shipping'; readonly providerId: string; readonly owner: string;
};
type ProviderAcknowledgement = {
  readonly status: 'provider-defined'; readonly defaultStatus: 200 | 500;
  readonly headers: 'provider-defined'; readonly contentType: 'provider-defined'; readonly body: 'provider-defined';
};
type DescribedProviderCallbackRoute = {
  readonly method: string; readonly path: string; readonly status: null; readonly auth: string;
  readonly kind: 'provider-callback'; readonly request: 'raw'; readonly providerKinds: readonly ['payment', 'shipping'];
  readonly rateLimit: 'callback'; readonly targets: readonly DescribedProviderCallbackTarget[];
  readonly acknowledgements: { readonly accepted: ProviderAcknowledgement; readonly rejected: ProviderAcknowledgement };
  readonly notFound: { readonly status: 404; readonly contentType: 'text/plain; charset=utf-8'; readonly body: 'Not found' };
  readonly rateLimited: { readonly status: 429; readonly retryAfter: true; readonly contentType: 'application/json'; readonly error: JsonSchema7Type };
};
type DescribedStorefrontRoute = {
  readonly method: string; readonly path: string; readonly status: null; readonly auth: string;
  readonly rateLimit: RateLimitBucket | null;
  readonly kind: 'storefront'; readonly request: StorefrontHttpContract['request']; readonly input: JsonSchema7Type;
  readonly params: Readonly<Record<string, string>>; readonly audience: 'customer' | null;
  readonly csrf: 'none' | 'same-origin' | 'session-csrf-or-same-origin';
  /** Guard and parser failures stay JSON; handler failures are Theme HTML in `responses`. */
  readonly guardError: JsonTransportError | null;
  readonly parserError: JsonTransportError | null;
  readonly responses: readonly StorefrontResponse[]; readonly cookieEffects: readonly StorefrontCookieEffect[];
};
type JsonTransportError = { readonly statuses: readonly number[]; readonly contentType: 'application/json'; readonly output: JsonSchema7Type };
type DescribedStorefrontAssetRoute = {
  readonly method: string; readonly path: string; readonly status: 200; readonly auth: 'session-or-anonymous';
  readonly rateLimit: RateLimitBucket | null;
  readonly kind: 'storefront-asset'; readonly request: 'none'; readonly input: JsonSchema7Type;
  readonly params: Readonly<Record<string, string>>; readonly allowedFiles: readonly string[];
  readonly success: { readonly contentType: 'image/png'; readonly cacheControl: 'public, max-age=0'; readonly body: 'binary' };
  readonly notFound: { readonly status: 404; readonly contentType: 'application/json'; readonly output: JsonSchema7Type };
  /** Public GET still rejects a malformed/invalid Bearer credential before the handler. */
  readonly guardError: JsonTransportError;
};
export type DescribedHttpRoute = (DescribedBusRoute | DescribedComposedRoute | DescribedDirectRoute | DescribedRawRoute | DescribedExtensionRoute | DescribedMcpRoute | DescribedProviderCallbackRoute | DescribedStorefrontRoute | DescribedStorefrontAssetRoute) & {
  /** The route's selected limiter bucket; unbounded routes are explicit. */
  readonly rateLimit: RateLimitBucket | null;
};

/** Release-owned routes are catalog entries too, but do not pretend to be Nest controllers. */
type StaticRouteBase = {
  readonly method: 'GET';
  readonly path: string;
  readonly auth: 'public';
  readonly request: 'none';
  readonly input: JsonSchema7Type;
};
export type StaticHttpRoute =
  | (StaticRouteBase & { readonly kind: 'static-admin-index'; readonly success: {
    readonly status: 200; readonly contentType: 'text/html; charset=utf-8'; readonly cacheControl: 'no-cache'; readonly body: 'index-html';
  } })
  | (StaticRouteBase & { readonly kind: 'static-admin-spa'; readonly success: {
    readonly status: 200; readonly body: 'static-file';
  }; readonly fallback: {
    readonly status: 200; readonly contentType: 'text/html; charset=utf-8'; readonly cacheControl: 'no-cache'; readonly body: 'index-html';
  } })
  | (StaticRouteBase & { readonly kind: 'static-theme-assets'; readonly success: {
    readonly status: 200; readonly body: 'static-file';
  }; readonly notFound: {
    readonly status: 404; readonly contentType: 'application/json'; readonly output: JsonSchema7Type;
  } });
export type CorsPreflightHttpRoute = {
  readonly method: 'OPTIONS'; readonly path: '*'; readonly kind: 'cors-preflight'; readonly automaticRoute: true;
  readonly auth: 'unauthenticated'; readonly request: 'headers';
  readonly requestHeaders: { readonly origin: 'required'; readonly accessControlRequestMethod: 'required'; readonly accessControlRequestHeaders: 'optional' };
  readonly policy: {
    readonly allowedOrigins: readonly string[]; readonly credentials: boolean; readonly methods: readonly string[];
    readonly allowedHeaders: readonly string[]; readonly exposedHeaders: readonly string[];
  };
  readonly responses: {
    readonly allowed: { readonly status: 204; readonly accessControlAllowOrigin: 'exact-origin'; readonly accessControlAllowCredentials: boolean };
    readonly denied: { readonly status: 204; readonly accessControlAllowOrigin: false; readonly accessControlAllowCredentials: boolean };
    readonly invalid: { readonly status: 400; readonly contentType: 'text/plain; charset=utf-8'; readonly body: 'Invalid Preflight Request' };
  };
};
export type ReleaseOwnedHttpRoute = StaticHttpRoute | CorsPreflightHttpRoute;
export type HttpRouteCatalogEntry = (DescribedHttpRoute | (ReleaseOwnedHttpRoute & { readonly rateLimit: null })) & {
  /** Fastify's automatic HEAD registration for this GET identity. */
  readonly automaticMethods?: readonly ['HEAD'];
};
export type MountedHttpRoute = { readonly method: string; readonly path: string };
export const HTTP_ROUTE_CATALOG = 'storeweaveHttpCatalog' as const;
export interface HttpRouteCatalogCarrier {
  readonly storeweaveHttpCatalog?: readonly HttpRouteCatalogEntry[];
}

export const HTTP_CONTRACT = 'storeweave:http-contract';
export const HttpContract = (contract: HttpRouteContract) => applyDecorators(
  SetMetadata(HTTP_CONTRACT, contract),
  RouteConfig({ storeweaveContract: contract }),
);

const errorSchema = () => zodToJsonSchema(httpErrorSchema as never, { target: 'jsonSchema7' });
const responseSchema = (output: unknown): JsonSchema7Type => ({ type: 'object', required: ['success', 'data'], properties: {
  success: { type: 'boolean', const: true }, data: zodToJsonSchema(output as never, { target: 'jsonSchema7' }),
} });

function extensionTargets(runtime: Runtime, kind: 'command' | 'query'): DescribedExtensionTarget[] {
  const expected = kind === 'command' ? runtime.commands : runtime.queries;
  const opposite = kind === 'command' ? runtime.queries : runtime.commands;
  return runtime.extensions.list().flatMap(extension => (kind === 'command' ? extension.commands : extension.queries).map(name => {
    if (!name.startsWith(`ext.${extension.id}.`)) {
      throw new Error(`Invalid extension ${kind} namespace: ${name}`);
    }
    if (!expected.has(name)) {
      if (opposite.has(name)) throw new Error(`Invalid extension ${kind} kind: ${name}`);
      throw new Error(`Missing extension ${kind} registration: ${name}`);
    }
    const registration = expected.get(name);
    if (registration.owner !== extension.id) {
      throw new Error(`Invalid extension ${kind} owner: ${name}`);
    }
    return {
      extensionId: extension.id, target: { kind, name }, owner: registration.owner,
      permission: registration.descriptor.permission,
      idempotency: 'idempotency' in registration.descriptor ? registration.descriptor.idempotency : 'none',
      input: zodToJsonSchema(registration.descriptor.input as never, { target: 'jsonSchema7' }),
      output: responseSchema(registration.descriptor.output),
    };
  }));
}

function mcpTools(runtime: Runtime): DescribedMcpTool[] {
  return runtime.mcpTools.list().map(({ definition, owner }) => {
    const registry = definition.target.kind === 'command' ? runtime.commands : runtime.queries;
    if (!registry.has(definition.target.name)) {
      throw new Error(`Missing MCP ${definition.target.kind} target: ${definition.target.name}`);
    }
    const target = registry.get(definition.target.name);
    return {
      name: definition.name, description: definition.description, owner, target: definition.target,
      targetOwner: target.owner, permission: target.descriptor.permission,
      idempotencyKey: definition.target.kind === 'command' ? 'tool-argument' : 'none',
      input: zodToJsonSchema(definition.input as never, { target: 'jsonSchema7' }),
    };
  });
}

function providerCallbackTargets(runtime: Runtime): DescribedProviderCallbackTarget[] {
  const targets: DescribedProviderCallbackTarget[] = [];
  for (const provider of runtime.providers.list()) {
    if (provider.kind === 'payment') {
      targets.push({ kind: provider.kind, providerId: provider.id, owner: provider.owner });
      continue;
    }
    if (provider.kind !== 'shipping') continue;
    const shipping = runtime.providers.get<ShippingProvider>('shipping', provider.id);
    if (shipping.parseCallback && shipping.acknowledgeCallback) {
      targets.push({ kind: provider.kind, providerId: provider.id, owner: provider.owner });
    }
  }
  return targets;
}

const jsonRpcId = z.union([z.string(), z.number(), z.null()]);
const mcpJsonRpcOutput = zodToJsonSchema(z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: jsonRpcId, result: z.object({}).passthrough() }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), id: jsonRpcId,
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).strict() }).strict(),
]) as never, { target: 'jsonSchema7' });

const mcpDirectOutput: JsonSchema7Type = {
  type: 'object', required: ['success', 'data'], additionalProperties: false, properties: {
    success: { type: 'boolean', const: true }, data: { type: 'object', required: ['protocolVersion', 'transport', 'tools'], additionalProperties: false, properties: {
      protocolVersion: { type: 'string', const: MCP_PROTOCOL_VERSION }, transport: { type: 'string', const: 'http-jsonrpc' },
      tools: { type: 'array', items: { type: 'object', required: ['name', 'owner', 'target'], additionalProperties: false, properties: {
        name: { type: 'string' }, owner: { type: 'string' }, target: { type: 'object', required: ['kind', 'name'], additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['command', 'query'] }, name: { type: 'string' },
        } },
      } } },
    } },
  },
};

/** Read the same Nest metadata that registers handlers; never copy their URLs. */
export function describeHttpRoutes(runtime: Runtime, controllers: readonly Type[]): DescribedHttpRoute[] {
  const seen = new Set<string>();
  return controllers.flatMap(controller => Object.getOwnPropertyNames(controller.prototype).flatMap<DescribedHttpRoute>(name => {
    const handler = controller.prototype[name];
    const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
    if (method === undefined) return [];
    const contract: HttpRouteContract | undefined = Reflect.getMetadata(HTTP_CONTRACT, handler);
    if (!contract) throw new Error(`Missing HTTP contract: ${controller.name}.${name}`);
    const paths = [Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler)];
    if (paths.some(path => typeof path !== 'string')) throw new Error(`Unsupported route path: ${controller.name}.${name}`);
    const path = '/' + paths.join('/').split('/').filter(Boolean).join('/');
    const verb = RequestMethod[method];
    const key = `${verb} ${path}`;
    if (seen.has(key)) throw new Error(`Duplicate HTTP route: ${key}`);
    seen.add(key);
    const flag = (metadata: string) => Reflect.getMetadata(metadata, handler) ?? Reflect.getMetadata(metadata, controller);
    let auth = flag(IS_EXTERNAL_CALLBACK) ? 'provider' : flag(IS_ANONYMOUS) ? 'anonymous'
      : flag(IS_PUBLIC) ? 'session-or-anonymous' : 'bearer-or-session';
    if (contract.kind === 'direct' && contract.auth === 'session') {
      if (auth !== 'bearer-or-session') throw new Error(`Invalid HTTP session requirement: ${path}`);
      auth = 'session';
    }
    if (contract.kind === 'storefront') {
      const externalCallback = Boolean(flag(IS_EXTERNAL_CALLBACK));
      if (contract.auth === 'opaque-capability') {
        if (!externalCallback) throw new Error(`Invalid storefront opaque capability: ${path}`);
        auth = 'opaque-capability';
      } else if (externalCallback) {
        throw new Error(`Missing storefront opaque capability: ${path}`);
      }
      const params = contract.params ?? {};
      const routeParams = [...path.matchAll(/:([^/]+)/g)].map(match => match[1]!);
      const properties = (contract.input as { properties?: Record<string, unknown> }).properties;
      if (routeParams.some(param => !Object.hasOwn(params, param)) ||
        Object.entries(params).some(([param, field]) => !routeParams.includes(param) || !properties || !Object.hasOwn(properties, field))) {
        throw new Error(`Invalid storefront parameter mapping: ${path}`);
      }
      const csrf = method === RequestMethod.GET || auth === 'opaque-capability' ? 'none'
        : auth === 'anonymous' ? 'same-origin' : 'session-csrf-or-same-origin';
      if (!contract.responses.length) throw new Error(`Missing storefront responses: ${path}`);
      return [{ method: verb, path, status: null, auth, kind: contract.kind, request: contract.request, rateLimit: contract.rateLimit ?? null,
        input: contract.input, params, audience: contract.audience ?? null, csrf,
        // Public routes inspect Bearer credentials before their anonymous fallback, even for GET.
        // Anonymous routes skip credentials; only unsafe requests reach same-origin validation.
        guardError: auth === 'session-or-anonymous' ? { statuses: method === RequestMethod.GET ? [401] : [401, 403], contentType: 'application/json', output: errorSchema() }
          : csrf === 'same-origin' ? { statuses: [403], contentType: 'application/json', output: errorSchema() } : null,
        // Fastify rejects malformed or over-limit form bodies before Nest invokes the handler.
        parserError: contract.request === 'form' ? { statuses: [400, 413], contentType: 'application/json', output: errorSchema() } : null,
        responses: contract.responses, cookieEffects: contract.cookieEffects ?? [],
      }];
    }
    if (contract.kind === 'storefront-asset') {
      const routeParams = [...path.matchAll(/:([^/]+)/g)].map(match => match[1]!);
      const properties = (contract.input as { properties?: Record<string, unknown> }).properties;
      if (routeParams.some(param => !Object.hasOwn(contract.params, param)) ||
        Object.entries(contract.params).some(([param, field]) => !routeParams.includes(param) || !properties || !Object.hasOwn(properties, field)) || auth !== 'session-or-anonymous') {
        throw new Error(`Invalid storefront asset contract: ${path}`);
      }
      return [{ method: verb, path, status: 200, auth: 'session-or-anonymous', kind: contract.kind, rateLimit: null,
        request: contract.request, input: contract.input, params: contract.params, allowedFiles: contract.allowedFiles,
        success: { contentType: 'image/png', cacheControl: 'public, max-age=0', body: 'binary' },
        notFound: { status: 404, contentType: 'application/json', output: errorSchema() },
        guardError: { statuses: [401], contentType: 'application/json', output: errorSchema() },
      }];
    }
    if (contract.kind === 'raw') return [{
      method: verb, path, status: contract.statuses[0], statuses: contract.statuses, auth,
      owner: null, kind: contract.kind, request: contract.request, permission: null, idempotency: 'none', rateLimit: contract.rateLimit ?? null,
      input: { type: 'object', properties: {}, additionalProperties: false }, output: contract.output,
    }];
    if (contract.kind === 'provider-callback') return [{
      method: verb, path, status: null, auth, kind: contract.kind, request: contract.request, providerKinds: contract.providerKinds,
      rateLimit: contract.rateLimit, targets: providerCallbackTargets(runtime),
      acknowledgements: {
        accepted: { status: 'provider-defined', defaultStatus: 200, headers: 'provider-defined', contentType: 'provider-defined', body: 'provider-defined' },
        rejected: { status: 'provider-defined', defaultStatus: 500, headers: 'provider-defined', contentType: 'provider-defined', body: 'provider-defined' },
      },
      notFound: { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' },
      rateLimited: { status: 429, retryAfter: true, contentType: 'application/json', error: errorSchema() },
    }];
    if (contract.kind === 'direct') return [{
      method: verb, path, status: Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? (method === RequestMethod.POST ? 201 : 200),
      auth, owner: null, kind: contract.kind, request: contract.request, permission: null, idempotency: 'none', rateLimit: contract.rateLimit ?? null,
      input: contract.input, error: errorSchema(), output: contract.output,
    }];
    if (contract.kind === 'mcp') return [{
      method: verb, path, status: Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? (method === RequestMethod.POST ? 201 : 200),
      auth, kind: contract.kind, transport: contract.transport, request: contract.request, rateLimit: contract.rateLimit ?? null,
      contentType: 'application/json', protocolVersion: MCP_PROTOCOL_VERSION, methods: MCP_METHOD_LIST, tools: mcpTools(runtime),
      input: contract.transport === 'jsonrpc'
        ? zodToJsonSchema(jsonRpcRequest as never, { target: 'jsonSchema7' })
        : { type: 'object', properties: {}, additionalProperties: false },
      error: errorSchema(),
      output: contract.transport === 'jsonrpc' ? mcpJsonRpcOutput : mcpDirectOutput,
    }];
    if (contract.kind === 'extension-command' || contract.kind === 'extension-query') return [{
      method: verb, path, status: Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? (method === RequestMethod.POST ? 201 : 200),
      auth, kind: contract.kind, request: contract.request, rateLimit: contract.rateLimit ?? null,
      ...(contract.kind === 'extension-query' ? { queryExtras: contract.queryExtras } : {}),
      targets: extensionTargets(runtime, contract.kind === 'extension-command' ? 'command' : 'query'), error: errorSchema(),
    }];
    const registration = contract.target.kind === 'command'
      ? runtime.commands.get(contract.target.name) : runtime.queries.get(contract.target.name);
    const { descriptor, owner } = registration;
    const declared = declaredInputKeys(descriptor.input);
    const injected = contract.kind === 'composed' ? contract.injected ?? [] : [];
    if (injected.some(field => !declared?.has(field))) throw new Error(`Invalid HTTP injected field: ${contract.target.name}`);
    const bodyFields = contract.kind === 'composed' ? contract.bodyFields : undefined;
    const serverDefaulted = contract.kind === 'composed' ? contract.serverDefaulted ?? [] : [];
    if ([...(bodyFields ?? []), ...serverDefaulted].some(field => !declared?.has(field)) ||
      ((bodyFields || serverDefaulted.length) && contract.request !== 'body') ||
      (bodyFields !== undefined && serverDefaulted.some(field => !bodyFields.includes(field))) ||
      serverDefaulted.some(field => injected.includes(field))) throw new Error(`Invalid HTTP body mapping: ${contract.target.name}`);
    let input: JsonSchema7Type = zodToJsonSchema(descriptor.input as never, { target: 'jsonSchema7' });
    if ('properties' in input) {
      const properties = input.properties;
      const pathFields = Object.values(contract.params ?? {});
      for (const field of injected) delete properties[field];
      if (contract.kind === 'composed' && contract.request === 'none') {
        for (const field of Object.keys(properties)) if (!pathFields.includes(field)) delete properties[field];
      }
      if (bodyFields) for (const field of Object.keys(properties)) {
        if (!bodyFields.includes(field) && !pathFields.includes(field)) delete properties[field];
      }
      if (input.required) input.required = input.required.filter(field => field in properties && !serverDefaulted.includes(field));
    }
    const routeParams = [...path.matchAll(/:([^/]+)/g)].map(match => match[1]!);
    const mappings = contract.params ?? {};
    if (routeParams.some(param => !Object.hasOwn(mappings, param)) ||
      Object.entries(mappings).some(([param, field]) => !routeParams.includes(param) || !declared?.has(field))) {
      throw new Error(`Invalid HTTP parameter mapping: ${path}`);
    }
    if (Object.keys(contract.queryEncoding ?? {}).some(field => contract.request !== 'query' || !declared?.has(field))) {
      throw new Error(`Invalid HTTP query encoding: ${path}`);
    }
    if (contract.nullAsMissing?.some(field => contract.request !== 'body' || !declared?.has(field))) {
      throw new Error(`Invalid HTTP null mapping: ${path}`);
    }
    return [{ method: verb, path, status: Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? (method === RequestMethod.POST ? 201 : 200),
      auth, owner, kind: contract.kind, target: contract.target, request: contract.request, rateLimit: contract.rateLimit ?? null, params: mappings, injected,
      queryEncoding: contract.queryEncoding ?? {}, permission: descriptor.permission,
      nullAsMissing: contract.nullAsMissing ?? [],
      bodyFields, serverDefaulted,
      idempotencyKey: contract.kind === 'composed' ? contract.idempotencyKey ?? 'request-header' : 'request-header',
      idempotency: 'idempotency' in descriptor ? descriptor.idempotency : 'none',
      input,
      error: errorSchema(),
      output: { type: 'object', required: ['success', 'data'], properties: {
        success: { const: true }, data: contract.kind === 'composed' && contract.output !== 'target' ? contract.output : zodToJsonSchema(descriptor.output as never, { target: 'jsonSchema7' }),
      } },
    } as DescribedBusRoute | DescribedComposedRoute];
  }));
}

/** Keep controller and release-owned routes in the same startup catalog. */
export function catalogHttpRoutes(
  runtime: Runtime,
  controllers: readonly Type[],
  releaseRoutes: readonly ReleaseOwnedHttpRoute[],
): HttpRouteCatalogEntry[] {
  const routes = [...describeHttpRoutes(runtime, controllers), ...releaseRoutes.map(route => ({ ...route, rateLimit: null } as const))];
  const seen = new Set<string>();
  for (const route of routes) {
    const identity = `${route.method} ${route.path}`;
    if (seen.has(identity)) throw new Error(`Duplicate HTTP route: ${identity}`);
    seen.add(identity);
  }
  return routes;
}

/**
 * Fastify creates HEAD from GET. It is recorded as route metadata, never a
 * second primary endpoint. Every other mounted identity must be cataloged.
 */
export function validateMountedHttpRoutes(
  catalog: readonly HttpRouteCatalogEntry[],
  mounted: readonly MountedHttpRoute[],
): HttpRouteCatalogEntry[] {
  const declared = new Map<string, HttpRouteCatalogEntry>();
  for (const route of catalog) {
    const identity = `${route.method} ${route.path}`;
    if (declared.has(identity)) throw new Error(`Duplicate HTTP route: ${identity}`);
    declared.set(identity, route);
  }

  const actual = new Set<string>();
  const automaticHeads = new Set<string>();
  for (const route of mounted) {
    const method = route.method.toUpperCase();
    const identity = `${method} ${route.path}`;
    if (method === 'HEAD') {
      const getIdentity = `GET ${route.path}`;
      if (!declared.has(getIdentity)) throw new Error(`Unexpected HTTP route: ${identity}`);
      automaticHeads.add(getIdentity);
      continue;
    }
    if (method === 'OPTIONS') {
      const declaredRoute = declared.get(identity);
      if (!declaredRoute || declaredRoute.kind !== 'cors-preflight' || !declaredRoute.automaticRoute) {
        throw new Error(`Unexpected HTTP route: ${identity}`);
      }
      if (actual.has(identity)) throw new Error(`Duplicate mounted HTTP route: ${identity}`);
      actual.add(identity);
      continue;
    }
    if (!declared.has(identity)) throw new Error(`Unexpected HTTP route: ${identity}`);
    if (actual.has(identity)) throw new Error(`Duplicate mounted HTTP route: ${identity}`);
    actual.add(identity);
  }
  for (const identity of declared.keys()) {
    if (!actual.has(identity)) throw new Error(`Declared HTTP route was not mounted: ${identity}`);
  }
  return catalog.map(route => automaticHeads.has(`${route.method} ${route.path}`)
    ? { ...route, automaticMethods: ['HEAD'] as const }
    : route);
}

export function busHttpInput(contract: BusHttpContract | ComposedHttpContract, input: unknown, params: Record<string, string> = {}, serverValues: Record<string, unknown> = {}): unknown {
  const injected = contract.kind === 'composed' ? contract.injected ?? [] : [];
  const allowed = [...injected, ...(contract.kind === 'composed' ? contract.serverDefaulted ?? [] : [])];
  if (Object.keys(serverValues).some(field => !allowed.includes(field))) throw new Error('Undeclared HTTP server value');
  if (injected.some(field => !Object.hasOwn(serverValues, field))) throw new Error('Missing HTTP server value');
  let value = input;
  if (contract.kind === 'composed' && contract.bodyFields) {
    const body = input as Record<string, unknown> | undefined;
    value = Object.fromEntries(contract.bodyFields.map(field => [field, body?.[field]]));
  }
  if (contract.nullAsMissing && value && typeof value === 'object' && !Array.isArray(value)) {
    const body = { ...value } as Record<string, unknown>;
    for (const field of contract.nullAsMissing) if (body[field] === null) body[field] = undefined;
    value = body;
  }
  if (contract.request === 'query' && value && typeof value === 'object' && !Array.isArray(value)) {
    const query = { ...value } as Record<string, unknown>;
    for (const [field, encoding] of Object.entries(contract.queryEncoding ?? {})) {
      const raw = query[field];
      if (raw === undefined) continue;
      if (typeof raw !== 'string') throw PlatformError.validation(`Invalid query field "${field}"`);
      // Preserve the existing distinction: System treats empty numbers as omitted;
      // Invoice/Notification use Number('') === 0 before descriptor validation.
      if (encoding === 'csv') query[field] = raw ? raw.split(',').filter(Boolean) : undefined;
      else if (encoding === 'boolean') query[field] = raw === 'true' ? true : raw === 'false' ? false : raw;
      else query[field] = encoding === 'number-empty-default' && raw === '' ? undefined : Number(raw);
    }
    value = query;
  }
  if (contract.params) {
    value = { ...(value as Record<string, unknown>),
      ...Object.fromEntries(Object.entries(contract.params).map(([param, field]) => [field, params[param]])),
    };
  }
  return allowed.length ? { ...(value as Record<string, unknown>), ...serverValues } : value;
}
