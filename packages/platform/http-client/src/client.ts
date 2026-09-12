import { checkDestination, safeUrl, type DestinationPolicy } from './destination';

const MAX_REDIRECTS = 5;
const MAX_ALLOWED_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 100;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 不帶副作用、重送不會多做一件事的方法。 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** 這些方法在 HTTP 規格上不得帶 body，fetch 會在送出前就拒絕。 */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** 這些狀態碼代表「現在不行，等一下也許可以」，其餘 4xx 重試只是浪費。 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * 跨 origin 轉址後仍可保留的 header。用白名單而不是黑名單：憑證放在
 * `x-api-key`、`x-auth-token` 這類自訂 header 的 provider 很常見，列黑名單
 * 等於保證漏掉還沒想到的那一個。
 */
const SAFE_CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'content-type', 'user-agent']);

/** 不交還給呼叫端的 response header。client 不維護 cookie jar，set-cookie 只會流進 log。 */
const WITHHELD_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

export interface HttpClientOptions extends DestinationPolicy {
  /** 一次嘗試的總預算，含所有轉址跳數。逾時會 abort 底層請求，不是只放棄等待。 */
  readonly timeoutMs: number;
  /** 含第一次在內的嘗試次數上限。預設 1，也就是不重試。 */
  readonly maxAttempts?: number;
  /** 願意讀進記憶體的回應大小。超過即中止，不把對方的頻寬變成我們的 OOM。 */
  readonly maxResponseBytes?: number;
  /** 測試接縫。預設用執行環境的 fetch。 */
  readonly fetch?: typeof fetch;
  /** 測試接縫，讓 backoff 不必真的等。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /**
   * 呼叫端保證這個請求重送不會產生第二個副作用（例如帶了 provider 的
   * idempotency key）。沒有這個宣告的 POST 一律不重試。
   */
  readonly idempotent?: boolean;
}

export type HttpFailureReason =
  | 'invalid_request'
  | 'blocked_destination'
  | 'unsafe_redirect'
  | 'too_many_redirects'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'response_too_large'
  | 'http_status'
  | 'invalid_json';

export interface HttpSuccess<T> {
  readonly ok: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
  readonly attempts: number;
}

export interface HttpFailure {
  readonly ok: false;
  readonly reason: HttpFailureReason;
  readonly status?: number;
  readonly message: string;
  readonly attempts: number;
}

export type HttpResult<T> = HttpSuccess<T> | HttpFailure;

export interface HttpClient {
  /** 回傳 response 主體的原始文字。 */
  request(input: HttpRequest): Promise<HttpResult<string>>;
  /**
   * 額外要求 JSON content type 並解析。空主體（例如 204）視為沒有內容，
   * `body` 為 undefined——建立資源後回 204 是常見做法，不該當成格式錯誤。
   */
  requestJson<T = unknown>(input: HttpRequest): Promise<HttpResult<T>>;
}

/** 已完整讀入的回應。分類與重試都在拿到它之後才決定。 */
interface Received {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly contentType: string | null;
  readonly text: string;
}

type AttemptOutcome =
  | { readonly kind: 'received'; readonly received: Received; readonly retryable: boolean }
  | { readonly kind: 'failed'; readonly failure: Omit<HttpFailure, 'attempts'>; readonly retryable: boolean };

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!WITHHELD_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

function crossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => SAFE_CROSS_ORIGIN_HEADERS.has(name.toLowerCase())));
}

function isJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

/** 丟掉不會再用的回應，讓底層連線可以歸還連線池。 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已經關閉或已讀完都無所謂，這只是歸還資源。
  }
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('An HTTP client needs a positive timeout');
  }
  const maxAttempts = options.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ALLOWED_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer between 1 and ${MAX_ALLOWED_ATTEMPTS}`);
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const injectedSleep = options.sleep;

  /** 測試替身可能不認 AbortSignal，所以在 client 邊界自己把 backoff 與 caller signal race。 */
  async function waitForRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      await (injectedSleep?.(ms) ?? new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
      return true;
    }
    if (signal.aborted) return false;
    if (!injectedSleep) {
      return new Promise<boolean>((resolve) => {
        const finish = (result: boolean) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = () => finish(false);
        const timer = setTimeout(() => finish(true), ms);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    let removeListener = () => {};
    const aborted = new Promise<false>((resolve) => {
      const onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
      removeListener = () => signal.removeEventListener('abort', onAbort);
    });
    try {
      return await Promise.race([injectedSleep(ms).then(() => true as const), aborted]);
    } finally {
      removeListener();
    }
  }

  /** 串流讀取並在超過預算時停手，而不是先整包收下再檢查大小。 */
  async function readWithinBudget(response: Response): Promise<{ ok: true; text: string } | { ok: false }> {
    if (!response.body) return { ok: true, text: '' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
  }

  /** 走完一次嘗試，含手動 redirect 與主體讀取。整段共用同一個逾時預算。 */
  async function attempt(input: HttpRequest): Promise<AttemptOutcome> {
    // 已取消就不要送出去。等 fetch 自己拒絕會白跑一趟真正的連線。
    if (input.signal?.aborted) {
      return { kind: 'failed', failure: { ok: false, reason: 'aborted', message: 'The caller cancelled the request' }, retryable: false };
    }

    const target = checkDestination(input.url, options);
    if (!target.ok) {
      return { kind: 'failed', failure: { ok: false, reason: 'blocked_destination', message: target.message }, retryable: false };
    }

    // 逾時只建立一次：每跳重新計時的話，`timeoutMs` 就變成「每一跳」的上限，
    // 一個一直轉址的端點可以把單次嘗試拖成 timeoutMs × 跳數。
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

    let headers = { ...input.headers };
    let currentUrl = target.url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        // 傳字串而非 URL 物件：既有測試與 fetch 替身都以字串比對目的地。
        response = await fetchImpl(currentUrl.toString(), {
          method: input.method,
          headers,
          ...(input.body === undefined ? {} : { body: input.body }),
          // 自己走每一跳，才能對每個目的地重跑允許清單。
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (input.signal?.aborted) {
          return { kind: 'failed', failure: { ok: false, reason: 'aborted', message: 'The caller cancelled the request' }, retryable: false };
        }
        if (timeout.aborted) {
          return {
            kind: 'failed',
            failure: { ok: false, reason: 'timeout', message: `${safeUrl(currentUrl)} did not respond within ${options.timeoutMs}ms` },
            retryable: true,
          };
        }
        return {
          kind: 'failed',
          // fetch/undici 與替身的 error/cause 可能逐字帶回 URL、header 或 provider
          // response；公開 failure 只保留已清理的 origin。
          failure: { ok: false, reason: 'network', message: `${safeUrl(currentUrl)} could not be reached` },
          retryable: true,
        };
      }

      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;

      if (location) {
        await discard(response);
        if (hop === MAX_REDIRECTS) {
          return {
            kind: 'failed',
            failure: { ok: false, reason: 'too_many_redirects', message: `${safeUrl(input.url)} redirected more than ${MAX_REDIRECTS} times` },
            retryable: false,
          };
        }
        // 帶 body 的請求被轉址時，重放到新目的地等於在別處再做一次副作用。
        if (input.body !== undefined) {
          return {
            kind: 'failed',
            failure: { ok: false, reason: 'unsafe_redirect', message: `${safeUrl(currentUrl)} redirected a request that carries a body` },
            retryable: false,
          };
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          return {
            kind: 'failed',
            failure: { ok: false, reason: 'unsafe_redirect', message: `${safeUrl(currentUrl)} returned an invalid redirect location` },
            retryable: false,
          };
        }
        const next = checkDestination(redirectUrl, options);
        if (!next.ok) {
          return { kind: 'failed', failure: { ok: false, reason: 'blocked_destination', message: `Redirect refused: ${next.message}` }, retryable: false };
        }
        if (next.url.origin !== currentUrl.origin) headers = crossOriginHeaders(headers);
        currentUrl = next.url;
        continue;
      }

      if (response.bodyUsed) {
        // 只有替身或呼叫端重複使用同一個 Response 才會這樣。那是程式錯誤，
        // 包裝成可重試的傳輸失敗會讓我們對外部端點多打好幾次。
        return {
          kind: 'failed',
          failure: { ok: false, reason: 'invalid_request', message: 'The response body has already been consumed' },
          retryable: false,
        };
      }

      const contentType = response.headers.get('content-type');
      const responseHeaders = headersToObject(response.headers);
      let body: { ok: true; text: string } | { ok: false };
      try {
        body = await readWithinBudget(response);
      } catch {
        // 主體讀到一半逾時是最典型的慢速端點樣態，分類必須跟連線逾時一致，
        // 才會走同一條重試路徑。讀取已中斷，reader 仍持有 stream，明確歸還。
        await discard(response);
        const reason = input.signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network';
        return {
          kind: 'failed',
          failure: {
            ok: false,
            reason,
            message: reason === 'aborted'
              ? 'The caller cancelled the request'
              : reason === 'timeout'
                ? `${safeUrl(currentUrl)} did not respond within ${options.timeoutMs}ms`
                : `${safeUrl(currentUrl)} response body could not be read`,
          },
          retryable: reason !== 'aborted',
        };
      }
      if (!body.ok) {
        return {
          kind: 'failed',
          failure: { ok: false, reason: 'response_too_large', status: response.status, message: `${safeUrl(currentUrl)} returned more than ${maxResponseBytes} bytes` },
          retryable: false,
        };
      }

      return {
        kind: 'received',
        received: { status: response.status, headers: responseHeaders, contentType, text: body.text },
        retryable: RETRYABLE_STATUSES.has(response.status),
      };
    }

    /* c8 ignore next */
    throw new Error('unreachable: redirect loop exited without a verdict');
  }

  async function run(input: HttpRequest): Promise<{ outcome: AttemptOutcome; attempts: number }> {
    const retriable = input.idempotent ?? IDEMPOTENT_METHODS.has(input.method.toUpperCase());
    const limit = retriable ? maxAttempts : 1;

    let last: AttemptOutcome | undefined;
    for (let attemptNumber = 1; attemptNumber <= limit; attemptNumber += 1) {
      last = await attempt(input);
      if (!last.retryable || attemptNumber === limit) return { outcome: last, attempts: attemptNumber };
      const shouldRetry = await waitForRetry(BASE_BACKOFF_MS * 2 ** (attemptNumber - 1), input.signal);
      if (!shouldRetry) {
        return {
          outcome: {
            kind: 'failed',
            failure: { ok: false, reason: 'aborted', message: 'The caller cancelled the request' },
            retryable: false,
          },
          attempts: attemptNumber,
        };
      }
    }
    /* c8 ignore next 2 */
    return { outcome: last!, attempts: limit };
  }

  function toResult(received: Received, attempts: number): HttpResult<string> {
    if (received.status < 200 || received.status >= 300) {
      return { ok: false, reason: 'http_status', status: received.status, message: `Responded with HTTP ${received.status}`, attempts };
    }
    return { ok: true, status: received.status, headers: received.headers, body: received.text, attempts };
  }

  return {
    async request(input) {
      if (input.body !== undefined && BODYLESS_METHODS.has(input.method.toUpperCase())) {
        return { ok: false, reason: 'invalid_request', message: `A ${input.method.toUpperCase()} request cannot carry a body`, attempts: 1 };
      }
      const { outcome, attempts } = await run(input);
      if (outcome.kind === 'failed') return { ...outcome.failure, attempts };
      return toResult(outcome.received, attempts);
    },

    async requestJson<T>(input: HttpRequest): Promise<HttpResult<T>> {
      if (input.body !== undefined && BODYLESS_METHODS.has(input.method.toUpperCase())) {
        return { ok: false, reason: 'invalid_request', message: `A ${input.method.toUpperCase()} request cannot carry a body`, attempts: 1 };
      }
      const { outcome, attempts } = await run(input);
      if (outcome.kind === 'failed') return { ...outcome.failure, attempts };

      const { received } = outcome;
      const raw = toResult(received, attempts);
      if (!raw.ok) return raw;
      if (received.text.trim() === '') {
        return { ok: true, status: received.status, headers: received.headers, body: undefined as T, attempts };
      }
      if (!isJson(received.contentType)) {
        return { ok: false, reason: 'invalid_json', status: received.status, message: `Expected JSON but the response declared ${received.contentType ?? 'no content type'}`, attempts };
      }
      try {
        return { ok: true, status: received.status, headers: received.headers, body: JSON.parse(received.text) as T, attempts };
      } catch {
        // 內容本身可能含個資，只回報「解析失敗」，不把主體放進訊息。
        return { ok: false, reason: 'invalid_json', status: received.status, message: 'The response body was not valid JSON', attempts };
      }
    },
  };
}
