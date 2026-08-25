import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShippingPage } from './ShippingPage';
import { I18nProvider } from '../i18n';
import { api, type EcpayLogisticsShipmentOperation, type Order, type Shipment, type ShippingMethod } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { listShippingMethods: vi.fn(), createShippingMethod: vi.fn(), updateShippingMethod: vi.fn(), listOrders: vi.fn(), createShipment: vi.fn(), getShipment: vi.fn(), advanceShipmentStage: vi.fn(), getShipmentLabelInfo: vi.fn(), getEcpayLogisticsShipmentOperation: vi.fn(), listEcpayLogisticsShipmentOperations: vi.fn(), retryEcpayLogisticsShipment: vi.fn(), listExtensions: vi.fn() } };
});

const method: ShippingMethod = {
  id: '11111111-1111-4111-8111-111111111111', code: 'ecpay-711', name: '7-ELEVEN 取貨', provider: 'ecpay-logistics', type: 'cvs', destinationKind: 'pickup_store', feeCents: 6000, freeShippingThresholdCents: 100000, enabled: true, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
};
const order: Order = {
  id: '22222222-2222-4222-8222-222222222222', number: 'SW-1002', status: 'paid', currency: 'TWD', customerEmail: 'buyer@example.com', subtotalCents: 100000, discountCents: 0, shippingCents: 6000, taxCents: 0, totalCents: 106000, lines: [], adjustments: [], delivery: { shippingMethodId: method.id, shippingMethodCode: method.code, shippingMethodName: method.name, provider: method.provider, type: method.type, destinationKind: 'pickup_store', destination: {}, createdAt: '2026-08-25T00:00:00.000Z' }, placedAt: '2026-08-25T00:00:00.000Z', paidAt: '2026-08-25T00:01:00.000Z', cancelledAt: null, expiresAt: null,
};
const shipment: Shipment = { id: '33333333-3333-4333-8333-333333333333', orderId: order.id, shippingMethodId: method.id, provider: method.provider, type: method.type, providerRef: 'carrier-1', trackingNumber: 'TRACK-1', status: 'created', createdAt: '2026-08-25T00:00:00.000Z', shippedAt: null, arrivedAt: null, completedAt: null, updatedAt: '2026-08-25T00:00:00.000Z' };
const failedOperation: EcpayLogisticsShipmentOperation = { shipmentId: shipment.id, orderId: order.id, status: 'failed', attempts: 3, manualRetries: 0, lastError: 'carrier create request failed', providerRef: null, trackingNumber: null, labelAvailable: false, lastKnownStage: 'created', lastStatusQueriedAt: '2026-08-25T00:01:00.000Z', lastStatusQueryError: 'carrier status query failed', jobId: 'dead-job-1', firstSeenAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:02:00.000Z' };

beforeEach(() => {
  vi.mocked(api.listShippingMethods).mockReset().mockResolvedValue({ items: [method], total: 1 });
  vi.mocked(api.createShippingMethod).mockReset().mockResolvedValue(method);
  vi.mocked(api.updateShippingMethod).mockReset().mockResolvedValue(method);
  vi.mocked(api.listOrders).mockReset().mockResolvedValue({ items: [order], total: 1 });
  vi.mocked(api.createShipment).mockReset().mockResolvedValue(shipment);
  vi.mocked(api.getShipment).mockReset().mockResolvedValue(shipment);
  vi.mocked(api.advanceShipmentStage).mockReset().mockResolvedValue({ ...shipment, status: 'shipped', shippedAt: '2026-08-25T01:00:00.000Z' });
  vi.mocked(api.getShipmentLabelInfo).mockReset().mockResolvedValue({ shipmentId: shipment.id, provider: shipment.provider, providerRef: 'carrier-1', labelReference: 'opaque-label-handle' });
  vi.mocked(api.getEcpayLogisticsShipmentOperation).mockReset().mockResolvedValue(null);
  vi.mocked(api.listEcpayLogisticsShipmentOperations).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(api.retryEcpayLogisticsShipment).mockReset().mockResolvedValue({ ...failedOperation, status: 'pending', manualRetries: 1, lastError: null });
  vi.mocked(api.listExtensions).mockReset().mockResolvedValue({
    items: [{ id: 'ecpay-logistics', name: 'ECPay Logistics', version: '1.0.0', platformVersion: '^1.0.0', permissions: [], subscribedEvents: [], commands: [], queries: [], providers: [], mcpTools: [] }],
  });
});

const renderPage = () => render(<I18nProvider><ShippingPage /></I18nProvider>);

describe('未安裝綠界物流時', () => {
  beforeEach(() => {
    vi.mocked(api.listExtensions).mockResolvedValue({ items: [] });
  });

  it('不去查一個不存在的 extension：那只會在 console 留下 404', async () => {
    renderPage();
    await screen.findByText('7-ELEVEN 取貨');
    await waitFor(() => expect(api.listExtensions).toHaveBeenCalled());
    expect(api.listEcpayLogisticsShipmentOperations).not.toHaveBeenCalled();
  });
});

describe('ShippingPage', () => {
  it('建立表單改由抽屜開啟：頁首動作事件會開抽屜而不是捲動頁面', async () => {
    renderPage();
    expect(await screen.findByText('7-ELEVEN 取貨')).toBeInTheDocument();

    expect(screen.queryByLabelText('配送代碼')).not.toBeInTheDocument();
    window.dispatchEvent(new CustomEvent('admin:action:create-shipping-method', { cancelable: true }));

    expect(await screen.findByLabelText('配送代碼')).toBeInTheDocument();
  });

  it('顯示配送方式並阻擋不合法的建立資料', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('7-ELEVEN 取貨')).toBeInTheDocument();
    window.dispatchEvent(new CustomEvent('admin:action:create-shipping-method', { cancelable: true }));
    await user.click(await screen.findByRole('button', { name: '建立配送方式' }));
    expect(await screen.findByText(/費率與免運門檻須為非負整數/)).toBeInTheDocument();
    expect(api.createShippingMethod).not.toHaveBeenCalled();
  });

  it('建立方法時送出正規化的契約欄位', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('7-ELEVEN 取貨');
    window.dispatchEvent(new CustomEvent('admin:action:create-shipping-method', { cancelable: true }));
    await user.type(await screen.findByLabelText('配送代碼'), 'home');
    await user.type(screen.getByLabelText('配送名稱'), '宅配');
    await user.type(screen.getByLabelText('Provider'), 'manual');
    await user.type(screen.getByLabelText('Type'), 'home');
    await user.click(screen.getByRole('button', { name: '建立配送方式' }));
    await waitFor(() => expect(api.createShippingMethod).toHaveBeenCalledWith(expect.objectContaining({ code: 'home', name: '宅配', provider: 'manual', type: 'home', feeCents: 0 })));
  });

  it('從已付款訂單建立物流單，且只顯示不透明標籤參照', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨工作台');
    await user.selectOptions(screen.getByLabelText('已付款訂單'), order.id);
    await user.click(screen.getByRole('button', { name: '建立物流單' }));
    await waitFor(() => expect(api.createShipment).toHaveBeenCalledWith({ orderId: order.id }));
    expect(screen.getByText('TRACK-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '讀取標籤列印參照' }));
    expect(await screen.findByText('opaque-label-handle')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /opaque-label-handle/i })).not.toBeInTheDocument();
  });

  it('只允許按出貨狀態機前進一個階段', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('出貨工作台');
    await user.type(screen.getByLabelText('物流單 ID'), shipment.id);
    await user.click(screen.getByRole('button', { name: '查詢物流單' }));
    await user.click(await screen.findByRole('button', { name: '標示為已出貨' }));
    await waitFor(() => expect(api.advanceShipmentStage).toHaveBeenCalledWith(shipment.id, 'shipped'));
  });

  it('顯示失敗的綠界作業稽核資訊，且只重試帶死信工作 ID 的失敗作業', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getEcpayLogisticsShipmentOperation).mockResolvedValue(failedOperation);
    vi.mocked(api.listEcpayLogisticsShipmentOperations).mockResolvedValue({ items: [failedOperation] });
    renderPage();
    await screen.findByText('失敗的綠界物流作業');
    await user.type(screen.getByLabelText('物流單 ID'), shipment.id);
    await user.click(screen.getByRole('button', { name: '查詢物流單' }));
    expect(await screen.findByText('carrier create request failed')).toBeInTheDocument();
    expect(screen.getAllByText('2026-08-25T00:00:00.000Z').length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: '重試綠界物流建單' }));
    await waitFor(() => expect(api.retryEcpayLogisticsShipment).toHaveBeenCalledWith(shipment.id));
    expect(api.createShipment).not.toHaveBeenCalled();
  });
});
