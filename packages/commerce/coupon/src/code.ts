import { randomInt } from 'node:crypto';

/**
 * 券碼的字母集。刻意排除 0/O、1/I/L、U（易與 V 混）——
 * 客服最不想處理的問題是「我明明打對了」。
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 系統產生的券碼長度。30 個字元的字母集下，12 碼約 59 bit，
 * 猜中一張的機率遠低於套用端點的節流所允許的嘗試次數。
 */
export const GENERATED_CODE_LENGTH = 12;

/** 每四碼一組，人念得出來也抄得對。 */
export function generateCouponCode(prefix?: string): string {
  let body = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i += 1) {
    // randomInt 走 CSPRNG：券碼可猜等於整檔活動的預算被領走。
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  const grouped = body.match(/.{1,4}/g)!.join('-');
  return prefix ? `${prefix.toUpperCase()}-${grouped}` : grouped;
}

export { ALPHABET as COUPON_CODE_ALPHABET };
