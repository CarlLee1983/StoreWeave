import { describe, expect, it } from 'vitest';
import { CART_COOKIE, SESSION_COOKIE, cookieName, readCookie, secureCookies } from '@storeweave/api';

describe('cookie 名字隨著能不能發 Secure 而變', () => {
  it('https 的部署用 __Host- 前綴', () => {
    expect(cookieName(SESSION_COOKIE, 'https://shop.example.com')).toBe('__Host-commerce_session');
    expect(cookieName(CART_COOKIE, 'https://shop.example.com')).toBe('__Host-commerce_cart');
  });

  it('本機以 http 開發時沒有前綴——__Host- 要求 Secure，加了瀏覽器會整張丟掉', () => {
    expect(cookieName(SESSION_COOKIE, 'http://localhost:3000')).toBe('commerce_session');
    expect(cookieName(SESSION_COOKIE, 'http://127.0.0.1:3000')).toBe('commerce_session');
  });

  it('http 但不是本機——仍然發 Secure，因此仍然加前綴（反向代理終止 TLS 的情況）', () => {
    expect(secureCookies('http://shop.example.com')).toBe(true);
    expect(cookieName(SESSION_COOKIE, 'http://shop.example.com')).toBe('__Host-commerce_session');
  });

  it('讀的時候只認當下該用的那一個名字，不回退到沒有前綴的版本', () => {
    const cookies = { commerce_session: 'forged', '__Host-commerce_session': 'real' };
    expect(readCookie(cookies, SESSION_COOKIE, 'https://shop.example.com')).toBe('real');
    expect(readCookie(cookies, SESSION_COOKIE, 'http://localhost:3000')).toBe('forged');
    expect(readCookie({ commerce_session: 'forged' }, SESSION_COOKIE, 'https://shop.example.com')).toBeUndefined();
  });
});
