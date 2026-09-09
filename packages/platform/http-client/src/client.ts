import { checkDestination, safeUrl, type DestinationPolicy } from './destination';

const MAX_REDIRECTS = 5;
const MAX_ALLOWED_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 100;

/** 不帶副作用、重送不會多做一件事的方法。 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** 這些狀態碼代表「現在不行，等一下也許可以」，其餘 4xx 重試只是浪費。 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface HttpClientOptions extends DestinationPolicy {
  /** 單次嘗試的上限。逾時會 abort 底層請求，不是只放棄等待。 */
  readonly timeoutMs: number;
  /** 含第一次在內的嘗試次數上限。預設 1，也就是不重試。 */
  readonly maxAttempts?: number;
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
  | 'blocked_destination'
  | 'unsafe_redirect'
  | 'too_many_redirects'
  | 'timeout'
  | 'aborted'
  | 'network'
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
  /** 額外要求 JSON content type 並解析；解析失敗自成一種結果。 */
  requestJson<T = unknown>(input: HttpRequest): Promise<HttpResult<T>>;
}

interface Attempt {
  readonly response?: Response;
  readonly failure?: Omit<HttpFailure, 'attempts'>;
  readonly retryable: boolean;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== 'authorization' && lower !== 'cookie' && lower !== 'proxy-authorization';
  }));
}

function isJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('An HTTP client needs a positive timeout');
  }
  const maxAttempts = options.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ALLOWED_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer between 1 and ${MAX_ALLOWED_ATTEMPTS}`);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  /** 走完一次請求，含手動 redirect。回傳 response 或已分類的失敗。 */
  async function attempt(input: HttpRequest): Promise<Attempt> {
    // 已取消就不要送出去。等 fetch 自己拒絕會白跑一趟真正的連線。
    if (input.signal?.aborted) {
      return { failure: { ok: false, reason: 'aborted', message: 'The caller cancelled the request' }, retryable: false };
    }

    const target = checkDestination(input.url, options);
    if (!target.ok) {
      return { failure: { ok: false, reason: 'blocked_destination', message: target.message }, retryable: false };
    }

    let headers = { ...input.headers };
    let currentUrl = target.url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

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
          return { failure: { ok: false, reason: 'aborted', message: 'The caller cancelled the request' }, retryable: false };
        }
        if (timeout.aborted) {
          return {
            failure: { ok: false, reason: 'timeout', message: `${safeUrl(currentUrl)} did not respond within ${options.timeoutMs}ms` },
            retryable: true,
          };
        }
        // 例外訊息可能含連線細節，但不含我們送出的 header 或 query。
        return {
          failure: { ok: false, reason: 'network', message: `${safeUrl(currentUrl)} could not be reached: ${(error as Error).message}` },
          retryable: true,
        };
      }

      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) return { response, retryable: RETRYABLE_STATUSES.has(response.status) };

      if (hop === MAX_REDIRECTS) {
        return {
          failure: { ok: false, reason: 'too_many_redirects', message: `${safeUrl(input.url)} redirected more than ${MAX_REDIRECTS} times` },
          retryable: false,
        };
      }

      // 帶 body 的請求被轉址時，重放到新目的地等於在別處再做一次副作用。
      if (input.body !== undefined) {
        return {
          failure: { ok: false, reason: 'unsafe_redirect', message: `${safeUrl(currentUrl)} redirected a request that carries a body` },
          retryable: false,
        };
      }

      const next = checkDestination(new URL(location, currentUrl), options);
      if (!next.ok) {
        return { failure: { ok: false, reason: 'blocked_destination', message: `Redirect refused: ${next.message}` }, retryable: false };
      }
      if (next.url.origin !== currentUrl.origin) headers = withoutAuthorization(headers);
      currentUrl = next.url;
    }

    /* c8 ignore next */
    throw new Error('unreachable: redirect loop exited without a verdict');
  }

  async function run(input: HttpRequest): Promise<{ result: Attempt; attempts: number }> {
    const retriable = input.idempotent ?? IDEMPOTENT_METHODS.has(input.method.toUpperCase());
    const limit = retriable ? maxAttempts : 1;

    let last: Attempt | undefined;
    for (let attemptNumber = 1; attemptNumber <= limit; attemptNumber += 1) {
      last = await attempt(input);
      const succeeded = last.response && !last.retryable;
      if (succeeded || !last.retryable || attemptNumber === limit) {
        return { result: last, attempts: attemptNumber };
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attemptNumber - 1));
    }
    /* c8 ignore next 2 */
    return { result: last!, attempts: limit };
  }

  async function readBody(response: Response, attempts: number): Promise<HttpResult<string>> {
    const headers = headersToObject(response.headers);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return { ok: false, reason: 'network', message: `The response body could not be read: ${(error as Error).message}`, attempts };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: 'http_status', status: response.status, message: `Responded with HTTP ${response.status}`, attempts };
    }
    return { ok: true, status: response.status, headers, body: text, attempts };
  }

  return {
    async request(input) {
      const { result, attempts } = await run(input);
      if (result.failure) return { ...result.failure, attempts };
      return readBody(result.response!, attempts);
    },

    async requestJson<T>(input: HttpRequest): Promise<HttpResult<T>> {
      const { result, attempts } = await run(input);
      if (result.failure) return { ...result.failure, attempts };
      const response = result.response!;
      const contentType = response.headers.get('content-type');
      const raw = await readBody(response, attempts);
      if (!raw.ok) return raw;
      if (!isJson(contentType)) {
        return { ok: false, reason: 'invalid_json', status: response.status, message: `Expected JSON but the response declared ${contentType ?? 'no content type'}`, attempts };
      }
      try {
        return { ok: true, status: raw.status, headers: raw.headers, body: JSON.parse(raw.body) as T, attempts };
      } catch {
        // 內容本身可能含個資，只回報「解析失敗」，不把主體放進訊息。
        return { ok: false, reason: 'invalid_json', status: response.status, message: 'The response body was not valid JSON', attempts };
      }
    },
  };
}
