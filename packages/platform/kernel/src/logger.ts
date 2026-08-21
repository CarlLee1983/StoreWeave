import pino from 'pino';
import type { Logger } from '@storeweave/contracts';
import { redact } from '@storeweave/audit';

export interface LoggerOptions {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  destination: 'stdout' | 'file';
  file?: string;
  name?: string;
}

/** 建立 pino logger。所有結構化欄位都會先經過 redact，機密不會進 log。 */
export function createLogger(options: LoggerOptions): Logger {
  const base = options.destination === 'file' && options.file
    ? pino({ level: options.level, name: options.name }, pino.destination({ dest: options.file, mkdir: true, sync: false }))
    : pino({ level: options.level, name: options.name });

  const wrap = (instance: pino.Logger): Logger => ({
    debug: (obj, msg) => log(instance, 'debug', obj, msg),
    info: (obj, msg) => log(instance, 'info', obj, msg),
    warn: (obj, msg) => log(instance, 'warn', obj, msg),
    error: (obj, msg) => log(instance, 'error', obj, msg),
    child: (bindings) => wrap(instance.child(redact(bindings) as Record<string, unknown>)),
  });
  return wrap(base);
}

function log(instance: pino.Logger, level: 'debug' | 'info' | 'warn' | 'error', obj: unknown, msg?: string) {
  if (typeof obj === 'string') instance[level](obj);
  else instance[level](redact(obj) as Record<string, unknown>, msg);
}
