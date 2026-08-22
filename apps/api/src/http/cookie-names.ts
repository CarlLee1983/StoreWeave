/**
 * cookie 的名字與 Secure 屬性，一起決定。
 *
 * `__Host-` 前綴是瀏覽器強制的三個條件：Secure、`Path=/`、**沒有** `Domain`。
 * 滿足了它，同一個註冊網域下的其他子網域就再也蓋不掉這些 cookie——
 * 沒有它，`evil.shop.example.com` 可以替 `shop.example.com` 寫一張
 * `commerce_session`，把受害者的操作導進攻擊者的帳號。
 *
 * 條件裡的 Secure 是本機以 http 開發時唯一拿不到的那一個，因此名字跟著
 * `secureCookies()` 走：發得出 Secure 就用前綴名，發不出就用裸名。
 */

/** 基底名。實際送到瀏覽器的名字見 `cookieName()`——可能多一個 `__Host-`。 */
export const SESSION_COOKIE = 'commerce_session';
export const CSRF_COOKIE = 'commerce_csrf';
/** 訪客購物車的識別碼。會員不需要它——他們的車綁在身分上。 */
export const CART_COOKIE = 'commerce_cart';
/**
 * 合併結果的一次性提示。合併發生在轉址之前，訊息沒有地方可以放，
 * 因此走 cookie 送到下一頁，讀到就清掉。
 */
export const CART_NOTICE_COOKIE = 'commerce_cart_notice';

const HOST_PREFIX = '__Host-';

/** 只有這四張。收成聯集之後，「寫的名字和讀的名字不一致」是編譯期問題而不是執行期問題。 */
export type CookieBase =
  | typeof SESSION_COOKIE
  | typeof CSRF_COOKIE
  | typeof CART_COOKIE
  | typeof CART_NOTICE_COOKIE;

/**
 * 只有本機開發才允許非 Secure cookie。TLS 由反向代理終止、publicUrl 卻誤寫成 http 時，
 * 用協定推導會讓 session cookie 靜默地以明文傳送。
 */
export function secureCookies(publicUrl: string): boolean {
  const { protocol, hostname } = new URL(publicUrl);
  return protocol === 'https:' || !['localhost', '127.0.0.1', '::1'].includes(hostname);
}

export function cookieName(base: CookieBase, publicUrl: string): string {
  return secureCookies(publicUrl) ? `${HOST_PREFIX}${base}` : base;
}

/**
 * **不回退**到沒有前綴的名字。回退等於把前綴買到的保護還回去：
 * 子網域寫得出裸名的 cookie，只要伺服器肯讀，攻擊就照樣成立。
 * 代價是換上前綴的那一刻，既有的 session 與訪客購物車全部作廢一次。
 */
export function readCookie(
  cookies: Record<string, string | undefined> | undefined,
  base: CookieBase,
  publicUrl: string,
): string | undefined {
  return cookies?.[cookieName(base, publicUrl)];
}

/** 呼叫端能決定的事。`path` / `domain` / `secure` 不在裡面——它們是前綴的前提，不是選項。 */
export interface HostCookieOptions {
  httpOnly?: boolean;
  sameSite: 'strict' | 'lax';
  maxAge?: number;
}

/**
 * 名字與屬性一起產出。
 *
 * 分成兩個各自獨立的決定就會走鐘：名字帶了前綴而 `secure` 是 false，或是有人補上
 * `domain` / 改掉 `path`——三種寫法型別都過得了，瀏覽器卻會把整張 cookie 靜默丟掉，
 * 而 `app.inject()` 不模擬瀏覽器的接受規則，測試也照樣全綠。因此呼叫端拿不到那三個鍵：
 * 展開在後面的 `path` / `secure` 蓋得掉傳進來的任何同名值。
 */
export function hostCookie(
  base: CookieBase,
  publicUrl: string,
  options: HostCookieOptions,
): { name: string; options: HostCookieOptions & { path: '/'; secure: boolean } } {
  // 逐鍵挑出來而不是展開：展開會把呼叫端多帶的 `domain` 一起帶進去，
  // 而 `domain` 的存在本身就會讓瀏覽器拒收帶前綴的 cookie。
  return {
    name: cookieName(base, publicUrl),
    options: {
      httpOnly: options.httpOnly,
      sameSite: options.sameSite,
      maxAge: options.maxAge,
      path: '/',
      secure: secureCookies(publicUrl),
    },
  };
}
