import { describe, expect, it } from 'vitest';
import { demoErpConfig, toErpDocument } from '@storeweave/ext-demo-erp';

const payload = {
  orderId: '22222222-2222-4222-8222-222222222222',
  orderNumber: 'SW-1001',
  customerEmail: 'buyer@example.com',
  currency: 'TWD',
  subtotalCents: 34_500,
  discountCents: 0,
  shippingCents: 0,
  taxCents: 0,
  totalCents: 34_500,
  adjustments: [],
  paidAt: new Date('2026-08-21T04:05:06.000Z'),
  paymentProvider: 'mock-payment',
  paymentRef: 'mock_abc',
  lines: [
    { productId: '33333333-3333-4333-8333-333333333333', sku: 'TEA-001', name: '高山烏龍', quantity: 3, unitPriceCents: 11_500, lineTotalCents: 34_500, discountCents: 0, netCents: 34_500 },
  ],
};

/** 折了 100 元的同一張單。 */
const discounted = {
  ...payload,
  discountCents: 10_000,
  totalCents: 24_500,
  adjustments: [{ source: 'promotion' as const, sourceId: 'promo-1', name: '滿千折百', amountCents: -10_000 }],
  lines: [{ ...payload.lines[0], discountCents: 10_000, netCents: 24_500 }],
};

describe('toErpDocument', () => {
  const config = demoErpConfig.parse({ companyCode: 'ACME', warehouseCode: 'TPE' });

  it('使用訂單編號作為去重 reference', () => {
    expect(toErpDocument(payload, config).reference).toBe('SO-SW-1001');
  });

  it('把 cents 轉成 ERP 慣用的金額', () => {
    const doc = toErpDocument(payload, config);
    expect(doc.body.TotalAmount).toBe(345);
    expect((doc.body.Items as any[])[0].UnitPrice).toBe(115);
  });

  it('帶入設定的公司與倉庫代碼', () => {
    const doc = toErpDocument(payload, config);
    expect(doc.body.CompanyCode).toBe('ACME');
    expect(doc.body.WarehouseCode).toBe('TPE');
  });

  it('行號以 10 為間隔', () => {
    expect((toErpDocument(payload, config).body.Items as any[])[0].LineNo).toBe(10);
  });

  it('日期只取到日', () => {
    expect(toErpDocument(payload, config).body.DocumentDate).toBe('2026-08-21');
  });

  it('單據金額是折扣後的實收，不是商品小計', () => {
    const doc = toErpDocument(discounted, config);
    expect(doc.body.SubtotalAmount).toBe(345);
    expect(doc.body.DiscountAmount).toBe(100);
    expect(doc.body.TotalAmount).toBe(245);
  });

  it('每一行帶自己的折扣與實收，對帳才對得起來', () => {
    const item = (toErpDocument(discounted, config).body.Items as any[])[0];
    expect(item.UnitPrice).toBe(115);
    expect(item.GrossAmount).toBe(345);
    expect(item.DiscountAmount).toBe(100);
    expect(item.Amount).toBe(245);
  });

  it('沒有折扣時單據內容與折扣前的語意一致', () => {
    const doc = toErpDocument(payload, config);
    expect(doc.body.DiscountAmount).toBe(0);
    expect(doc.body.TotalAmount).toBe(345);
    expect((doc.body.Items as any[])[0].Amount).toBe(345);
  });
});
