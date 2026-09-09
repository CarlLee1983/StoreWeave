/**
 * 對外 HTTP 只走這一層。Extension 直接呼叫 fetch 會各自長出一套 timeout 與
 * 重試規則——這正是 B12 要收掉的東西。
 */
export type {
  HttpClient, HttpClientOptions, HttpFailure, HttpFailureReason, HttpRequest, HttpResult, HttpSuccess,
} from '@storeweave/http-client';

/** Extension 取得 HTTP client 的方式。allowedHosts 未給時沿用平台預設政策。 */
export interface ExtensionHttpFactory {
  (options: {
    readonly timeoutMs: number;
    readonly allowedHosts?: readonly string[];
    readonly maxAttempts?: number;
    readonly allowInsecureHttp?: boolean;
    readonly allowPrivateAddresses?: boolean;
    readonly maxResponseBytes?: number;
  }): import('@storeweave/http-client').HttpClient;
}
