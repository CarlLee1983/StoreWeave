import pino from 'pino';
import type { Logger } from '@storeweave/contracts';
import { redact } from '@storeweave/audit';

export interface LoggerOptions {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /**
   * `stderr` 給 CLI 用：指令的答案寫 stdout，診斷寫 stderr，
   * `--json` 才餵得進 jq。設定檔只認得 stdout / file，這一項是呼叫端決定的。
   */
  destination: 'stdout' | 'stderr' | 'file';
  file?: string;
  name?: string;
}

/** 建立 pino logger。所有結構化欄位都會先經過 redact，機密不會進 log。 */
export function createLogger(options: LoggerOptions): Logger {
  const base = pino({ level: options.level, name: options.name }, destinationFor(options));

  const wrap = (instance: pino.Logger): Logger => ({
    debug: (obj, msg) => log(instance, 'debug', obj, msg),
    info: (obj, msg) => log(instance, 'info', obj, msg),
    warn: (obj, msg) => log(instance, 'warn', obj, msg),
    error: (obj, msg) => log(instance, 'error', obj, msg),
    child: (bindings) => wrap(instance.child(redact(bindings) as Record<string, unknown>)),
  });
  return wrap(base);
}

function destinationFor(options: LoggerOptions): pino.DestinationStream | undefined {
  if (options.destination === 'file' && options.file) {
    return pino.destination({ dest: options.file, mkdir: true, sync: false });
  }
  // 2 是 stderr 的 fd。sync 讓行程結束前寫得出去——CLI 跑完就退出，來不及 flush。
  if (options.destination === 'stderr') return pino.destination({ dest: 2, sync: true });
  return undefined;
}

function log(instance: pino.Logger, level: 'debug' | 'info' | 'warn' | 'error', obj: unknown, msg?: string) {
  // level 先判斷再 redact：redact 是一次遞迴 clone，而 Query 成功那一行走 debug，
  // 落在前台每次渲染都會打好幾次的路徑上。pino 自己會擋掉被 level 過濾的那一行，
  // 但擋不住我們在它之前就做完的那次 clone。
  if (!instance.isLevelEnabled(level)) return;
  if (typeof obj === 'string') instance[level](obj);
  else instance[level](redact(obj) as Record<string, unknown>, msg);
}
