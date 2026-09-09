import type { NotificationTemplate } from '@storeweave/notifications';

/**
 * B07 之後密碼重設信直接走 base 的 `@storeweave/notifications`，不再經過
 * Extension 的 `NotificationProvider`。版本跟著內容走——改了字就要進版。
 */
export const PASSWORD_RESET_TEMPLATE: NotificationTemplate = {
  id: 'customer.password-reset',
  version: 1,
  email: {
    subject: 'Reset your password',
    text: 'Use this link to reset your password: {resetUrl}\nThe link expires in {expiresInMinutes} minutes.',
    html: '<p>Use this link to reset your password: <a href="{resetUrl}">{resetUrl}</a></p><p>The link expires in {expiresInMinutes} minutes.</p>',
    translations: {
      zh: {
        subject: '重設您的密碼',
        text: '請透過以下連結重設密碼：{resetUrl}\n連結將於 {expiresInMinutes} 分鐘後失效。',
        html: '<p>請透過以下連結重設密碼：<a href="{resetUrl}">{resetUrl}</a></p><p>連結將於 {expiresInMinutes} 分鐘後失效。</p>',
      },
    },
  },
};
