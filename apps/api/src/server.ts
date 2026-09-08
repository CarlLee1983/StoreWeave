import { createReleaseServer, type ReleaseServerOptions } from './release-server';
import { httpAdapter } from './releases/commerce';

export type ServerOptions = Omit<ReleaseServerOptions, 'httpAdapter'>;
/** Compatibility entrypoint for the existing Commerce integration. */
export function createServer(options: ServerOptions) {
  return createReleaseServer({ ...options, httpAdapter });
}
