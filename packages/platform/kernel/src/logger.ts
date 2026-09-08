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
  /** 直接指定寫到哪裡；給 `createMemoryLogger()` 用，正式路徑不傳。 */
  stream?: pino.DestinationStream;
}

/** 建立 pino logger。所有結構化欄位都會先經過 redact，機密不會進 log。 */
export function createLogger(options: LoggerOptions): Logger & { close(): Promise<void> } {
  const ownedFile = !options.stream && options.destination === 'file' && options.file
    ? pino.destination({ dest: options.file, mkdir: true, sync: false }) : undefined;
  let fileFailure: Error | undefined;
  let fileOpened = false;
  const fileClosed = ownedFile ? new Promise<void>(resolve => {
    ownedFile.once('ready', () => { fileOpened = true; });
    ownedFile.once('close', resolve);
    ownedFile.on('error', error => {
      fileFailure = error;
      // An unsuccessful open owns no descriptor and SonicBoom never emits close.
      if (!fileOpened) resolve();
      else ownedFile.destroy();
    });
  }) : Promise.resolve();
  let base: pino.Logger;
  try { base = pino({ level: options.level, name: options.name }, ownedFile ?? destinationFor(options)); }
  catch (error) { ownedFile?.destroy(); throw error; }
  let closing: Promise<void> | undefined;

  const wrap = (instance: pino.Logger): Logger => ({
    debug: (obj, msg) => log(instance, 'debug', obj, msg),
    info: (obj, msg) => log(instance, 'info', obj, msg),
    warn: (obj, msg) => log(instance, 'warn', obj, msg),
    error: (obj, msg) => log(instance, 'error', obj, msg),
    child: (bindings) => wrap(instance.child(redact(bindings) as Record<string, unknown>)),
  });
  return {
    ...wrap(base),
    close() {
      return closing ??= (async () => {
        if (ownedFile && !fileFailure) ownedFile.end();
        await fileClosed;
        if (fileFailure) throw fileFailure;
      })();
    },
  };
}

export interface CapturedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg?: string;
  /** pino 寫出去的其餘欄位（含 `child()` 的 binding）。 */
  fields: Record<string, unknown>;
}

const PINO_LEVELS: Record<number, CapturedLine['level']> = { 20: 'debug', 30: 'info', 40: 'warn', 50: 'error' };

/**
 * 寫進記憶體的 logger，給要斷言「log 上出現了什麼」的測試用。
 *
 * 它走的是與正式環境同一條 `createLogger()`——手刻一個假 logger 驗不到兩件事：
 * `redact()` 有沒有蓋到那個欄位，以及 level 過濾擋不擋得掉那一行。
 * 那兩件事正是這一層存在的理由。
 */
export function createMemoryLogger(options: { level?: LoggerOptions['level']; name?: string } = {}): {
  logger: Logger;
  lines: CapturedLine[];
} {
  const lines: CapturedLine[] = [];
  const logger = createLogger({
    level: options.level ?? 'debug',
    destination: 'stdout',
    name: options.name,
    stream: {
      write(chunk: string) {
        const { level, msg, time: _time, pid: _pid, hostname: _hostname, name: _name, ...fields } = JSON.parse(chunk);
        lines.push({ level: PINO_LEVELS[level] ?? 'debug', msg, fields });
      },
    },
  });
  return { logger, lines };
}

function destinationFor(options: LoggerOptions): pino.DestinationStream | undefined {
  if (options.stream) return options.stream;
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
