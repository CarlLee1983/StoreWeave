import type { MailTemplate } from '@storeweave/mail';

/**
 * 身分信件的模板由 identity 自己擁有，不再經 NotificationProvider extension：
 * base release 沒有那個 provider，而重設密碼是 base 必須自己做到的事。
 *
 * 版本號在渲染契約改變時才加一。B06 的佇列會快照渲染結果，所以已排隊的信
 * 不會被之後的模板編輯改寫。
 */

const FOOTER_HTML = '<p>如果這不是您本人的操作，忽略這封信即可，帳號不會有任何變動。</p>';
const FOOTER_TEXT = '如果這不是您本人的操作，忽略這封信即可，帳號不會有任何變動。';

export const PASSWORD_RESET_TEMPLATE: MailTemplate = {
  id: 'identity.password-reset',
  version: 1,
  subject: 'Reset your {storeName} password',
  html: '<p>Hi {displayName},</p><p><a href="{url}">Choose a new password</a>. The link expires in {expiresInMinutes} minutes.</p><p>If this was not you, ignore this message.</p>',
  text: 'Hi {displayName},\n\nChoose a new password: {url}\nThe link expires in {expiresInMinutes} minutes.\n\nIf this was not you, ignore this message.',
  translations: {
    zh: {
      subject: '重設 {storeName} 的密碼',
      html: `<p>{displayName} 您好：</p><p><a href="{url}">設定新密碼</a>，連結 {expiresInMinutes} 分鐘內有效。</p>${FOOTER_HTML}`,
      text: '{displayName} 您好：\n\n設定新密碼：{url}\n連結 {expiresInMinutes} 分鐘內有效。\n\n' + FOOTER_TEXT,
    },
  },
};

export const EMAIL_VERIFICATION_TEMPLATE: MailTemplate = {
  id: 'identity.email-verification',
  version: 1,
  subject: 'Confirm your {storeName} email address',
  html: '<p>Hi {displayName},</p><p><a href="{url}">Confirm this address</a>. The link expires in {expiresInMinutes} minutes.</p><p>If this was not you, ignore this message.</p>',
  text: 'Hi {displayName},\n\nConfirm this address: {url}\nThe link expires in {expiresInMinutes} minutes.\n\nIf this was not you, ignore this message.',
  translations: {
    zh: {
      subject: '確認您的 {storeName} 電子郵件',
      html: `<p>{displayName} 您好：</p><p><a href="{url}">確認這個信箱</a>，連結 {expiresInMinutes} 分鐘內有效。</p>${FOOTER_HTML}`,
      text: '{displayName} 您好：\n\n確認這個信箱：{url}\n連結 {expiresInMinutes} 分鐘內有效。\n\n' + FOOTER_TEXT,
    },
  },
};

/** 這一封只寄到「新的」地址：舊地址的持有者證明不了他還拿得到新地址。 */
export const EMAIL_CHANGE_TEMPLATE: MailTemplate = {
  id: 'identity.email-change',
  version: 1,
  subject: 'Confirm your new {storeName} email address',
  html: '<p>Hi {displayName},</p><p>Confirm that {newEmail} belongs to you: <a href="{url}">confirm the change</a>. The link expires in {expiresInMinutes} minutes.</p><p>If this was not you, ignore this message.</p>',
  text: 'Hi {displayName},\n\nConfirm that {newEmail} belongs to you: {url}\nThe link expires in {expiresInMinutes} minutes.\n\nIf this was not you, ignore this message.',
  translations: {
    zh: {
      subject: '確認您的新 {storeName} 電子郵件',
      html: `<p>{displayName} 您好：</p><p>請確認 {newEmail} 是您的信箱：<a href="{url}">確認變更</a>，連結 {expiresInMinutes} 分鐘內有效。</p>${FOOTER_HTML}`,
      text: '{displayName} 您好：\n\n請確認 {newEmail} 是您的信箱：{url}\n連結 {expiresInMinutes} 分鐘內有效。\n\n' + FOOTER_TEXT,
    },
  },
};
