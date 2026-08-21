import { describe, expect, it } from 'vitest';
import { demoErpConfig, toErpDocument } from '@storeweave/ext-demo-erp';

const payload = {
  orderId: '22222222-2222-4222-8222-222222222222',
  orderNumber: 'SW-1001',
  customerEmail: 'buyer@example.com',
  currency: 'TWD',
  totalCents: 34_500,
  paidAt: new Date('2026-08-21T04:05:06.000Z'),
  paymentProvider: 'mock-payment',
  paymentRef: 'mock_abc',
  lines: [
    { productId: '33333333-3333-4333-8333-333333333333', sku: 'TEA-001', name: '高山烏龍', quantity: 3, unitPriceCents: 11_500, lineTotalCents: 34_500 },
  ],
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
});
