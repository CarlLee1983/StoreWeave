export interface DestinationPolicy {
  /**
   * 允許連往的目的地，寫成 `host` 或 `host:port`。省略 port 表示只准該協定的
   * 預設 port。未設定表示不限制 host——設定檔裡的端點是營運者指定的，不是使用者
   * 輸入。一旦某條路徑會接受外部提供的 URL，那條路徑必須給清單。
   */
  readonly allowedHosts?: readonly string[];
  /** 允許 http。預設只准 https；本機 mock 與開發環境才需要打開。 */
  readonly allowInsecureHttp?: boolean;
  /**
   * 允許連往迴環、私有與 link-local 位址。預設拒絕：否則一個可由後台修改的
   * endpoint 設定，就足以把平台當成內網掃描與 cloud metadata 讀取的跳板。
   * 內網 ERP 這類正當用途必須明確打開，讓風險留在設定裡看得見。
   */
  readonly allowPrivateAddresses?: boolean;
}

export type DestinationVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly message: string };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * 判斷 hostname 是否指向本機或內網。只看字面位址：主機名稱要靠 DNS 才知道，
 * 而先查再連仍然擋不住 rebinding，所以那不是這一層宣稱能提供的保證。
 * 真正需要嚴格隔離的部署應同時在網路層限制出站。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    // ::1 迴環、fe80:: link-local、fc00::/7 unique local。
    return address === '::1' || address === '::' || address.startsWith('fe80:') || /^f[cd]/.test(address);
  }

  const match = IPV4.exec(host);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if (match.slice(1).some((part) => Number(part) > 255)) return true;
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 允許清單條目正規化成 `hostname` 或 `hostname:port`，讓 Unicode 網域也比得中。 */
function normaliseEntry(entry: string): string {
  try {
    const url = new URL(`https://${entry}`);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return entry.toLowerCase();
  }
}

function authorityOf(url: URL): string[] {
  return url.port ? [`${url.hostname}:${url.port}`, url.hostname] : [url.hostname];
}

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
  if (!policy.allowPrivateAddresses && isPrivateHost(url.hostname)) {
    return { ok: false, message: `The destination ${url.hostname} is a loopback or private address` };
  }

  if (policy.allowedHosts) {
    // 完全比對：字尾比對會讓 notexample.com 混進 example.com 的清單，
    // 子網域也必須逐一列出，不從父網域繼承。
    const entries = new Set(policy.allowedHosts.map(normaliseEntry));
    // 條目沒寫 port 時，只有預設 port 的 URL 算數；URL 帶了非預設 port 就必須
    // 有對應的 `host:port` 條目，否則同一台機器上的其他服務也會被放行。
    const candidates = url.port ? [`${url.hostname}:${url.port}`] : authorityOf(url);
    if (!candidates.some((candidate) => entries.has(candidate.toLowerCase()))) {
      return { ok: false, message: `The destination ${candidates[0]} is not on the allowlist` };
    }
  }

  return { ok: true, url };
}

/**
 * 可以出現在錯誤訊息與 log 裡的 URL：只留 origin。
 *
 * path 也不能留——webhook token（`/services/T000/B000/<token>`）、`/v1/keys/<key>`、
 * Telegram 的 `/bot<token>/…` 都把秘密放在路徑上，而這些字串會進到 job 的錯誤欄位。
 */
export function safeUrl(raw: string | URL): string {
  try {
    return (raw instanceof URL ? raw : new URL(raw)).origin;
  } catch {
    return '[unparseable url]';
  }
}
