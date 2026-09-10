interface EmailContent { subject: string; html: string; text: string }
export interface CouponNotificationTemplate {
  id: string;
  version: number;
  email: EmailContent & { translations: Record<string, EmailContent> };
}

/**
 * 自動發券的通知內容。version 跟著內容走——改了字就要進版，
 * 已經排隊的信不會被改寫。
 */
export const COUPON_TEMPLATES: Record<'signup' | 'birthday', CouponNotificationTemplate> = {
  signup: {
    id: 'customer.coupon-signup', version: 1,
    email: {
      subject: 'A welcome coupon is waiting for you',
      text: 'Thanks for signing up! Your coupon code(s): {codes}.',
      html: '<p>Thanks for signing up! Your coupon code(s): <strong>{codes}</strong>.</p>',
      translations: {
        zh: {
          subject: '您的註冊禮券已送達',
          text: '歡迎加入！您的券碼：{codes}。',
          html: '<p>歡迎加入！您的券碼：<strong>{codes}</strong>。</p>',
        },
      },
    },
  },
  birthday: {
    id: 'customer.coupon-birthday', version: 1,
    email: {
      subject: 'Happy birthday! A coupon is on us',
      text: 'Happy birthday! Your coupon code(s): {codes}.',
      html: '<p>Happy birthday! Your coupon code(s): <strong>{codes}</strong>.</p>',
      translations: {
        zh: {
          subject: '生日快樂！您的生日禮券已送達',
          text: '生日快樂！您的券碼：{codes}。',
          html: '<p>生日快樂！您的券碼：<strong>{codes}</strong>。</p>',
        },
      },
    },
  },
};
