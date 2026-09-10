interface EmailContent { subject: string; html: string; text: string }
export interface LoyaltyNotificationTemplate {
  id: string;
  version: number;
  email: EmailContent & { translations: Record<string, EmailContent> };
}

/**
 * 購物金到期通知的內容。version 跟著內容走——改了字就要進版，
 * 已經排隊的信不會被改寫。
 */
export const REWARD_EXPIRING_TEMPLATE: LoyaltyNotificationTemplate = {
  id: 'customer.reward-expiring', version: 1,
  email: {
    subject: 'Your reward balance is expiring soon',
    text: '{amountCents} cents of your reward balance will expire on {expiresAt}.',
    html: '<p><strong>{amountCents}</strong> cents of your reward balance will expire on <strong>{expiresAt}</strong>.</p>',
    translations: {
      zh: {
        subject: '您的購物金即將到期',
        text: '您有 {amountCents} 元的購物金將於 {expiresAt} 到期。',
        html: '<p>您有 <strong>{amountCents}</strong> 元的購物金將於 <strong>{expiresAt}</strong> 到期。</p>',
      },
    },
  },
};
