export interface DestinationPolicy {
  /**
   * 允許連往的 host。未設定表示不限制 host——設定檔裡的端點是營運者指定的，
   * 不是使用者輸入。一旦某條路徑會接受外部提供的 URL，那條路徑必須給清單。
   */
  readonly allowedHosts?: readonly string[];
  /** 允許 http。預設只准 https；本機 mock 與開發環境才需要打開。 */
  readonly allowInsecureHttp?: boolean;
}

export type DestinationVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly message: string };

/**
 * 判斷一個目的地能不能連。每一次 redirect 都要重跑，否則允許清單只擋得住
 * 第一跳——而攻擊者控制的正是後面幾跳。
 */
export function checkDestination(raw: string | URL, policy: DestinationPolicy): DestinationVerdict {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    return { ok: false, message: 'The destination is not a valid URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: `The destination protocol ${url.protocol} is not allowed` };
  }
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) {
    return { ok: false, message: 'The destination must use https' };
  }
  if (url.username || url.password) {
    // URL 裡的帳密會跟著 log 與錯誤訊息四處流動，改用 header 傳。
    return { ok: false, message: 'The destination must not carry credentials in the URL' };
  }

  if (policy.allowedHosts) {
    const host = url.hostname.toLowerCase();
    // 完全比對：字尾比對會讓 notexample.com 混進 example.com 的清單，
    // 子網域也必須逐一列出，不從父網域繼承。
    const allowed = policy.allowedHosts.some((entry) => entry.toLowerCase() === host);
    if (!allowed) return { ok: false, message: `The destination host ${host} is not on the allowlist` };
  }

  return { ok: true, url };
}

/** 可以出現在錯誤訊息與 log 裡的 URL：去掉帳密與 query。 */
export function safeUrl(raw: string | URL): string {
  try {
    const url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[unparseable url]';
  }
}
