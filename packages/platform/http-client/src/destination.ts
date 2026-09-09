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
 * 把 IPv4 目的地包進 IPv6 的四種前綴：IPv4-mapped（`::ffff:`）、SIIT（`::ffff:0:`）、
 * 已淘汰的 IPv4-compatible（`::`）與 NAT64（`64:ff9b::`）。URL parser 會把點分寫法
 * 正規化成十六進位（`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`），所以比對的是後者，
 * 最後兩個 hextet 就是那個 IPv4 位址。
 */
const IPV4_IN_IPV6 = /^(?:::ffff:0:|::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * 6to4（`2002::/16`）把 IPv4 放在第二、三個 hextet，位置與上面那一族不同，
 * 所以另外一條規則。RFC 7526 已淘汰公共 relay，但設了 6to4 通道的主機仍會路由。
 */
const SIXTOFOUR = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/;

/** RFC 8215 的 local-use NAT64 前綴，與 `64:ff9b::/96` 同一族。 */
const NAT64_LOCAL = /^64:ff9b:1:(?:.*:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

function isPrivateIpv4(host: string): boolean {
  const match = IPV4.exec(host);
  if (!match) return false;
  const [a, b, c] = match.slice(1).map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 192.0.0.0/24 是 IETF protocol assignments，192.0.2.0/24 是 TEST-NET-1；
  // 192.0.78.0 之類的其餘 192.0.0.0/16 是一般可路由位址，不能一起擋。
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  // multicast、reserved 與 broadcast 都不會是合法的 webhook 目的地。
  if (a >= 224) return true;
  return false;
}

function ipv4FromHextets(high: string, low: string): string {
  const value = (parseInt(high, 16) << 16) + parseInt(low, 16);
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

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
    if (address === '::1' || address === '::' || address.startsWith('fe80:') || /^f[cd]/.test(address)) return true;
    // IPv4 位址包成 IPv6 仍然連得到那個 IPv4 目的地，必須套用同一組規則。
    for (const pattern of [IPV4_IN_IPV6, SIXTOFOUR, NAT64_LOCAL]) {
      const embedded = pattern.exec(address);
      if (embedded) return isPrivateIpv4(ipv4FromHextets(embedded[1], embedded[2]));
    }
    return false;
  }

  return isPrivateIpv4(host);
}

/** 允許清單條目正規化成 `hostname` 或 `hostname:port`，讓 Unicode 網域也比得中。 */
function normaliseEntry(entry: string): string {
  // 條目寫成 URL 或萬用字元時直接拒絕：`https://example.com` 會被解析成主機名
  // `https`，`*.example.com` 不會展開，兩者都會永遠比不中而難以除錯。
  if (entry.includes('/') || entry.includes('*')) {
    throw new Error(`Invalid allowlist entry "${entry}": write a host or host:port, not a URL or wildcard`);
  }
  let url: URL;
  try {
    url = new URL(`https://${entry}`);
  } catch {
    throw new Error(`Invalid allowlist entry "${entry}": not a host`);
  }
  if (url.hostname === '' || url.pathname !== '/' || url.username || url.password) {
    throw new Error(`Invalid allowlist entry "${entry}": write a host or host:port`);
  }
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/** 該協定的預設 port。條目與 URL 都正規化到「不寫」的形式再比對。 */
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

function authorityOf(url: URL): string {
  const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';
  return `${url.hostname}${port}`;
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
    // 子網域也必須逐一列出，不從父網域繼承。寫明預設 port 與省略視為同一件事。
    const entries = new Set(policy.allowedHosts.map((entry) => {
      const normalised = normaliseEntry(entry);
      const [host, port] = normalised.split(':');
      return port && port === DEFAULT_PORTS[url.protocol] ? host : normalised;
    }));
    const authority = authorityOf(url);
    if (!entries.has(authority)) {
      return { ok: false, message: `The destination ${authority} is not on the allowlist` };
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
