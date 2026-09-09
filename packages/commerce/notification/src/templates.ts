import type { LifecycleTemplate } from './dto';

interface EmailContent { subject: string; html: string; text: string }
export interface LifecycleNotificationTemplate {
  id: string;
  version: number;
  email: EmailContent & { translations: Record<string, EmailContent> };
}

/**
 * 事件到內容的對應留在 commerce：base 只知道「通知某個收件人」，
 * 不知道什麼是訂單。版本跟著內容走——改了字就要進版，排隊中的信不會被改寫。
 */
export const LIFECYCLE_TEMPLATES: Record<LifecycleTemplate, LifecycleNotificationTemplate> = {
  'customer.order-placed': {
    id: 'customer.order-placed', version: 1,
    email: {
      subject: 'Order {orderNumber} received',
      text: 'We received your order {orderNumber}. We will let you know once it is paid and on its way.',
      html: '<p>We received your order <strong>{orderNumber}</strong>. We will let you know once it is paid and on its way.</p>',
      translations: {
        zh: {
          subject: '已收到訂單 {orderNumber}',
          text: '我們已經收到您的訂單 {orderNumber}，付款完成與出貨時都會再通知您。',
          html: '<p>我們已經收到您的訂單 <strong>{orderNumber}</strong>，付款完成與出貨時都會再通知您。</p>',
        },
      },
    },
  },
  'customer.order-paid': {
    id: 'customer.order-paid', version: 1,
    email: {
      subject: 'Payment received for {orderNumber}',
      text: 'Your payment for order {orderNumber} is confirmed. We are preparing your shipment.',
      html: '<p>Your payment for order <strong>{orderNumber}</strong> is confirmed. We are preparing your shipment.</p>',
      translations: {
        zh: {
          subject: '訂單 {orderNumber} 已收到款項',
          text: '訂單 {orderNumber} 的付款已確認，我們正在準備出貨。',
          html: '<p>訂單 <strong>{orderNumber}</strong> 的付款已確認，我們正在準備出貨。</p>',
        },
      },
    },
  },
  'customer.shipment-shipped': {
    id: 'customer.shipment-shipped', version: 1,
    email: {
      subject: 'Order {orderNumber} has shipped',
      text: 'Shipment {shipmentId} for order {orderNumber} is on its way.',
      html: '<p>Shipment <strong>{shipmentId}</strong> for order <strong>{orderNumber}</strong> is on its way.</p>',
      translations: {
        zh: {
          subject: '訂單 {orderNumber} 已出貨',
          text: '訂單 {orderNumber} 的包裹 {shipmentId} 已經寄出。',
          html: '<p>訂單 <strong>{orderNumber}</strong> 的包裹 <strong>{shipmentId}</strong> 已經寄出。</p>',
        },
      },
    },
  },
  'customer.shipment-arrived': {
    id: 'customer.shipment-arrived', version: 1,
    email: {
      subject: 'Order {orderNumber} has arrived',
      text: 'Shipment {shipmentId} for order {orderNumber} has arrived.',
      html: '<p>Shipment <strong>{shipmentId}</strong> for order <strong>{orderNumber}</strong> has arrived.</p>',
      translations: {
        zh: {
          subject: '訂單 {orderNumber} 已送達',
          text: '訂單 {orderNumber} 的包裹 {shipmentId} 已經送達。',
          html: '<p>訂單 <strong>{orderNumber}</strong> 的包裹 <strong>{shipmentId}</strong> 已經送達。</p>',
        },
      },
    },
  },
};
