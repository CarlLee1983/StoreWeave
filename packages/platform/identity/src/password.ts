import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt 是 Node 內建的記憶體困難雜湊。
 * 刻意不用 argon2 —— 它是原生模組，會讓 native release 每個架構都得預先編譯，
 * 與「目標主機不需要編譯工具鏈」的部署前提衝突（見 ADR 0007）。
 */
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const PREFIX = 'scrypt';

/** 成本參數寫進雜湊字串本身，日後調高才有漸進升級路徑，不必強制全體重設密碼。 */
const COST = { N: 16384, r: 8, p: 1 };
const maxmemFor = (N: number, r: number) => 256 * N * r;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(plain, salt, KEY_BYTES, { ...COST, maxmem: maxmemFor(COST.N, COST.r) });
  return `${PREFIX}:${COST.N}:${COST.r}:${COST.p}:${salt.toString('base64')}:${key.toString('base64')}`;
}

function isCostInRange(N: number, r: number, p: number): boolean {
  // 上界貼著實際會用到的參數。放寬到 N=262144,r=16,p=4 時單次驗證要 4.5 秒與約 512MB，
  // 那是拿到資料庫寫入權限後的 DoS 放大器，而我們從來不需要那組值。
  return (
    Number.isInteger(N) && N >= 16384 && N <= 65536 && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 8 &&
    p === 1
  );
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, nRaw, rRaw, pRaw, saltPart, keyPart] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // 成本參數來自資料庫欄位。上界不是防使用者，是防「有資料庫寫入權限的人把一次登入
  // 變成好幾秒與好幾 GB 的運算」——那是 DoS，不是雜湊強度。
  if (!isCostInRange(N, r, p)) return false;

  const salt = Buffer.from(saltPart!, 'base64');
  const expected = Buffer.from(keyPart!, 'base64');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;

  try {
    const actual = await scrypt(plain, salt, KEY_BYTES, { N, r, p, maxmem: maxmemFor(N, r) });
    return timingSafeEqual(actual, expected);
  } catch (err) {
    // 儲存的雜湊壞掉是驗證失敗，不是伺服器錯誤——否則登入端點會回 500 而不是 401。
    // 但記憶體不足這類暫時性失敗必須往上拋：把它當成密碼錯誤會讓故障完全無聲。
    if ((err as NodeJS.ErrnoException).code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS') return false;
    throw err;
  }
}

/**
 * 帳號不存在時拿來比對的雜湊。它必須是**合法**雜湊：
 * 否則 verifyPassword 會在格式檢查就提早返回，登入耗時直接洩漏帳號存不存在。
 */
export const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(32).toString('hex'));
