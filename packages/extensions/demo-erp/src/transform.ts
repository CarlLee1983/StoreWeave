import type { ErpDocument } from '@storeweave/extension-sdk';
import type { DemoErpConfig } from './config';
import { erpReference } from './state';

export interface PaidOrderEventPayload {
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  currency: string;
  totalCents: number;
  paidAt: Date | string;
  paymentProvider: string;
  paymentRef: string;
  lines: {
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }[];
}

/**
 * 把版本化的 `commerce.order.paid.v1` payload 轉成模擬 ERP 的單據格式。
 * 這裡是純函式，可以完全脫離平台測試。
 */
export function toErpDocument(payload: PaidOrderEventPayload, config: DemoErpConfig): ErpDocument {
  const paidAt = payload.paidAt instanceof Date ? payload.paidAt : new Date(payload.paidAt);
  return {
    documentType: config.documentType,
    reference: erpReference(payload.orderNumber),
    body: {
      CompanyCode: config.companyCode,
      WarehouseCode: config.warehouseCode,
      DocumentNo: erpReference(payload.orderNumber),
      DocumentDate: paidAt.toISOString().slice(0, 10),
      CustomerRef: payload.customerEmail,
      CurrencyCode: payload.currency,
      PaymentMethod: payload.paymentProvider,
      PaymentRef: payload.paymentRef,
      TotalAmount: centsToAmount(payload.totalCents),
      Items: payload.lines.map((line, index) => ({
        LineNo: (index + 1) * 10,
        ItemCode: line.sku,
        ItemName: line.name,
        Quantity: line.quantity,
        UnitPrice: centsToAmount(line.unitPriceCents),
        Amount: centsToAmount(line.lineTotalCents),
      })),
    },
  };
}

/**
 * 實際交給 HTTP ERP `/documents` 的 JSON 本體。
 *
 * 這個投影同時供 provider 和受 `erp:read` 保護的營運檢視使用，避免 inspector
 * 與實際送出的欄位逐漸分岔。它不包含 ERP API key 或任何 HTTP header。
 */
export function toErpHttpPayload(document: ErpDocument): Record<string, unknown> {
  return { documentType: document.documentType, reference: document.reference, ...document.body };
}

function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}
