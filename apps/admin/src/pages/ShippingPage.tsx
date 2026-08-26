import { useEffect, useState } from 'react';
import { api, type EcpayLogisticsShipmentOperation, type Order, type Shipment, type ShipmentLabelInfo, type ShippingMethod } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { useEscapeKey } from '../hooks/useEscapeKey';

type MethodForm = {
  code: string; name: string; provider: string; type: string;
  destinationKind: ShippingMethod['destinationKind']; feeCents: string; freeShippingThresholdCents: string; enabled: boolean;
};

const EMPTY_METHOD: MethodForm = {
  code: '', name: '', provider: '', type: '', destinationKind: 'taiwan_home', feeCents: '0', freeShippingThresholdCents: '', enabled: true,
};
const CODE = /^[A-Za-z0-9._-]+$/;

function methodFormOf(method: ShippingMethod): MethodForm {
  return {
    code: method.code, name: method.name, provider: method.provider, type: method.type,
    destinationKind: method.destinationKind, feeCents: String(method.feeCents),
    freeShippingThresholdCents: method.freeShippingThresholdCents === null ? '' : String(method.freeShippingThresholdCents), enabled: method.enabled,
  };
}

function methodPayload(form: MethodForm, includeCode: boolean):
  | { code: string; name: string; provider: string; type: string; destinationKind: ShippingMethod['destinationKind']; feeCents: number; freeShippingThresholdCents?: number; enabled: boolean }
  | Error {
  const feeCents = Number(form.feeCents);
  const threshold = form.freeShippingThresholdCents.trim() === '' ? undefined : Number(form.freeShippingThresholdCents);
  if (!form.name.trim() || !CODE.test(form.provider) || !CODE.test(form.type) || !Number.isInteger(feeCents) || feeCents < 0
    || (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0)) || (includeCode && !CODE.test(form.code))) {
    return new Error('請填寫代碼、名稱、provider、type；費率與免運門檻須為非負整數。');
  }
  return {
    ...(includeCode ? { code: form.code.trim() } : { code: '' }),
    name: form.name.trim(), provider: form.provider.trim(), type: form.type.trim(), destinationKind: form.destinationKind,
    feeCents, ...(threshold === undefined ? {} : { freeShippingThresholdCents: threshold }), enabled: form.enabled,
  };
}

export function ShippingPage() {
  const [methods, setMethods] = useState<ShippingMethod[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ShippingMethod | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([api.listShippingMethods({ limit: 100 }), api.listOrders({ status: 'paid', limit: 100 })])
      .then(([methodResult, orderResult]) => {
        if (!cancelled) { setMethods(methodResult.items); setOrders(orderResult.items); }
      })
      .catch((reason) => !cancelled && setError(reason))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [reloadKey]);

  const reload = () => setReloadKey((value) => value + 1);

  // 頁首那顆「建立配送方式」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開抽屜，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => {
      event.preventDefault();
      setCreating(true);
    };
    window.addEventListener('admin:action:create-shipping-method', openCreate);
    return () => window.removeEventListener('admin:action:create-shipping-method', openCreate);
  }, []);

  return <section>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {loading ? <Loading /> : <ShippingMethodList methods={methods} onEdit={setEditing} />}
    <ShipmentWorkbench orders={orders.filter((order) => Boolean(order.delivery))} />
    {creating ? <CreateMethodDrawer onClose={() => setCreating(false)} onCreated={reload} /> : null}
    {editing ? <EditMethodDrawer method={editing} onClose={() => setEditing(null)} onChanged={reload} /> : null}
  </section>;
}

function MethodFields({ form, onChange, immutableCode = false }: { form: MethodForm; onChange: <K extends keyof MethodForm>(key: K, value: MethodForm[K]) => void; immutableCode?: boolean }) {
  return <div className="drawer-form-body">
    <div className="form-field">
      <label htmlFor="shipping-method-code"><span className="field-label-text">代碼</span></label>
      <input id="shipping-method-code" aria-label="配送代碼" className="mono" disabled={immutableCode} value={form.code} onChange={(event) => onChange('code', event.target.value)} />
    </div>
    <div className="form-field">
      <label htmlFor="shipping-method-name"><span className="field-label-text">名稱</span></label>
      <input id="shipping-method-name" aria-label="配送名稱" value={form.name} onChange={(event) => onChange('name', event.target.value)} />
    </div>
    <div className="form-grid-2">
      <div className="form-field">
        <label htmlFor="shipping-method-provider"><span className="field-label-text">Provider</span></label>
        <input id="shipping-method-provider" aria-label="Provider" value={form.provider} onChange={(event) => onChange('provider', event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="shipping-method-type"><span className="field-label-text">Type</span></label>
        <input id="shipping-method-type" aria-label="Type" value={form.type} onChange={(event) => onChange('type', event.target.value)} />
      </div>
    </div>
    <div className="form-field">
      <label htmlFor="shipping-method-destination"><span className="field-label-text">目的地</span></label>
      <select id="shipping-method-destination" aria-label="目的地" value={form.destinationKind} onChange={(event) => onChange('destinationKind', event.target.value as MethodForm['destinationKind'])}>
        <option value="taiwan_home">台灣宅配</option>
        <option value="pickup_store">超商取貨</option>
      </select>
    </div>
    <div className="form-grid-2">
      <div className="form-field">
        <label htmlFor="shipping-method-fee"><span className="field-label-text">費率（cents）</span></label>
        <input id="shipping-method-fee" aria-label="費率（cents）" className="mono" value={form.feeCents} onChange={(event) => onChange('feeCents', event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="shipping-method-threshold"><span className="field-label-text">免運門檻（cents）</span></label>
        <input id="shipping-method-threshold" aria-label="免運門檻（cents）" className="mono" value={form.freeShippingThresholdCents} onChange={(event) => onChange('freeShippingThresholdCents', event.target.value)} />
      </div>
    </div>
    <label className="checkbox"><input aria-label="啟用配送方式" type="checkbox" checked={form.enabled} onChange={(event) => onChange('enabled', event.target.checked)} /> 啟用</label>
  </div>;
}

/** 建立配送方式抽屜：版型比照 ProductsPage 的 CreateProductDrawer。 */
function CreateMethodDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<MethodForm>(EMPTY_METHOD);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const update = <K extends keyof MethodForm>(key: K, value: MethodForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  useEscapeKey(onClose);

  const submit = async () => {
    const payload = methodPayload(form, true);
    if (payload instanceof Error) { setError(payload); return; }
    setSubmitting(true); setError(null);
    try { await api.createShippingMethod(payload); onCreated(); onClose(); }
    catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div className="payload-drawer product-edit-drawer" role="dialog" aria-modal="true" aria-label="建立配送方式" onMouseDown={(e) => e.stopPropagation()}>
        <header className="product-drawer-header">
          <div><h2>建立配送方式</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="關閉" title="關閉">
            <Icon name="chevron" />
          </button>
        </header>
        <form className="form-panel product-drawer-form" aria-label="建立配送方式" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          <MethodFields form={form} onChange={update} />
          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>取消</button>
            <button className="button button--primary" disabled={submitting}>{submitting ? '建立中…' : '建立配送方式'}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function ShippingMethodList({ methods, onEdit }: { methods: ShippingMethod[]; onEdit: (method: ShippingMethod) => void }) {
  return <section className="account-panel" aria-label="配送方式清單">
    <div className="section-heading"><h2>配送方式</h2><p>停用會保留既有訂單的配送快照；此 API 沒有刪除端點。</p></div>
    {methods.length === 0 ? <EmptyState icon="truck" title="目前沒有配送方式" hint="建立配送方式之後，前台結帳才有得選。" /> : <div className="table-wrap"><table className="data-table data-table--fixed"><thead><tr>
      <th style={{ width: '12%' }}>代碼</th>
      <th style={{ width: '18%' }}>名稱</th>
      <th style={{ width: '18%' }}>Provider / Type</th>
      <th style={{ width: '14%' }}>目的地</th>
      <th style={{ width: '10%' }} className="col-numeric">費率</th>
      <th style={{ width: '12%' }} className="col-numeric">免運門檻</th>
      <th style={{ width: '8%' }}>狀態</th>
      <th style={{ width: '8%' }} className="col-actions">操作</th>
    </tr></thead><tbody>
      {methods.map((method) => <tr key={method.id}>
        <td className="mono">{method.code}</td>
        <td>{method.name}</td>
        <td>{method.provider} / {method.type}</td>
        <td>{method.destinationKind === 'pickup_store' ? '超商取貨' : '台灣宅配'}</td>
        <td className="col-numeric">{method.feeCents}</td>
        <td className="col-numeric">{method.freeShippingThresholdCents ?? '—'}</td>
        <td><StatusBadge value={method.enabled ? 'active' : 'disabled'} /></td>
        <td className="col-actions"><button className="button button--quiet" type="button" onClick={() => onEdit(method)}><Icon name="pencil" /> 編輯</button></td>
      </tr>)}
    </tbody></table></div>}
  </section>;
}

/** 編輯配送方式抽屜：與建立共用同一套欄位，代碼建立後不可更改。 */
function EditMethodDrawer({ method, onClose, onChanged }: { method: ShippingMethod; onClose: () => void; onChanged: () => void }) {
  const [form, setForm] = useState(() => methodFormOf(method));
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const update = <K extends keyof MethodForm>(key: K, value: MethodForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  useEscapeKey(onClose);

  const submit = async () => {
    const payload = methodPayload(form, false);
    if (payload instanceof Error) { setError(payload); return; }
    const { code: _code, ...updatePayload } = payload;
    setSubmitting(true); setError(null);
    try {
      await api.updateShippingMethod(method.id, { ...updatePayload, freeShippingThresholdCents: form.freeShippingThresholdCents.trim() === '' ? null : updatePayload.freeShippingThresholdCents });
      onChanged(); onClose();
    } catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div className="payload-drawer product-edit-drawer" role="dialog" aria-modal="true" aria-label={`編輯 ${method.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="product-drawer-header">
          <div>
            <h2>編輯 {method.name}</h2>
            <p className="product-drawer-sku">代碼：<span className="mono">{method.code}</span></p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="關閉" title="關閉">
            <Icon name="chevron" />
          </button>
        </header>
        <form className="form-panel product-drawer-form" aria-label={`編輯 ${method.name}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          <MethodFields form={form} onChange={update} immutableCode />
          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>取消</button>
            <button className="button button--primary" disabled={submitting}>{submitting ? '儲存中…' : '儲存變更'}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function ShipmentWorkbench({ orders }: { orders: Order[] }) {
  const [orderId, setOrderId] = useState('');
  const [shipmentId, setShipmentId] = useState('');
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [operation, setOperation] = useState<EcpayLogisticsShipmentOperation | null>(null);
  const [failedOperations, setFailedOperations] = useState<EcpayLogisticsShipmentOperation[]>([]);
  const [label, setLabel] = useState<ShipmentLabelInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ecpayInstalled, setEcpayInstalled] = useState(false);
  const loadFailedOperations = async () => setFailedOperations((await api.listEcpayLogisticsShipmentOperations({ status: 'failed', limit: 50 })).items);
  // 綠界物流是選配 extension：沒安裝就整塊不查也不顯示。
  // 無條件查詢等於每次進頁面都在 console 留一筆 404。
  useEffect(() => {
    let cancelled = false;
    void api.listExtensions()
      .then((result) => {
        if (cancelled || !result.items.some((extension) => extension.id === 'ecpay-logistics')) return;
        setEcpayInstalled(true);
        return loadFailedOperations();
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const loadOperation = async (value: Shipment) => {
    setOperation(value.provider === 'ecpay-logistics' ? await api.getEcpayLogisticsShipmentOperation(value.id) : null);
  };
  const inspect = async () => { if (!shipmentId.trim()) { setError(new Error('請輸入物流單 ID。')); return; } setSubmitting(true); setError(null); try { const found = await api.getShipment(shipmentId.trim()); setShipment(found); await loadOperation(found); setLabel(null); } catch (reason) { setError(reason); } finally { setSubmitting(false); } };
  const create = async () => { if (!orderId) { setError(new Error('請選擇已付款且有配送快照的訂單。')); return; } setSubmitting(true); setError(null); try { const created = await api.createShipment({ orderId }); setShipment(created); setShipmentId(created.id); await loadOperation(created); setLabel(null); } catch (reason) { setError(reason); } finally { setSubmitting(false); } };
  const advance = async () => { const next = shipment?.status === 'created' ? 'shipped' : shipment?.status === 'shipped' ? 'arrived' : shipment?.status === 'arrived' ? 'completed' : null; if (!shipment || !next) return; setSubmitting(true); setError(null); try { setShipment(await api.advanceShipmentStage(shipment.id, next)); } catch (reason) { setError(reason); } finally { setSubmitting(false); } };
  const labelInfo = async () => { if (!shipment) return; setSubmitting(true); setError(null); try { setLabel(await api.getShipmentLabelInfo(shipment.id)); } catch (reason) { setError(reason); } finally { setSubmitting(false); } };
  const retry = async () => {
    if (!operation || operation.status !== 'failed' || !operation.jobId) return;
    setSubmitting(true); setError(null);
    try { setOperation(await api.retryEcpayLogisticsShipment(operation.shipmentId)); await loadFailedOperations(); }
    catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };
  const nextLabel = shipment?.status === 'created' ? '標示為已出貨' : shipment?.status === 'shipped' ? '標示為已到店／送達' : shipment?.status === 'arrived' ? '標示為已完成' : null;
  return <section className="account-panel" aria-label="出貨工作台"><div className="section-heading"><h2>出貨工作台</h2><p>僅可從已付款、已有配送快照的訂單建單。目的地快照不在此編輯。</p></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <div className="inline-form"><label>已付款訂單<select aria-label="已付款訂單" value={orderId} onChange={(event) => setOrderId(event.target.value)}><option value="">選擇訂單</option>{orders.map((order) => <option key={order.id} value={order.id}>{order.number} · {order.delivery!.shippingMethodName}</option>)}</select></label><button className="button button--primary" type="button" disabled={submitting} onClick={() => void create()}>建立物流單</button></div>
    <div className="inline-form"><label>物流單 ID<input aria-label="物流單 ID" value={shipmentId} onChange={(event) => setShipmentId(event.target.value)} /></label><button className="button" type="button" disabled={submitting} onClick={() => void inspect()}>查詢物流單</button></div>
    {shipment ? <div className="order-detail"><dl className="order-totals"><dt>狀態</dt><dd><StatusBadge value={shipment.status} /></dd><dt>Provider</dt><dd>{shipment.provider} / {shipment.type}</dd><dt>Provider reference</dt><dd className="mono"><span className="cell-truncate" title={shipment.providerRef ?? undefined}>{shipment.providerRef ?? '—'}</span></dd><dt>追蹤號</dt><dd className="mono"><span className="cell-truncate" title={shipment.trackingNumber ?? undefined}>{shipment.trackingNumber ?? '—'}</span></dd><dt>建立時間</dt><dd>{shipment.createdAt}</dd><dt>最後更新</dt><dd>{shipment.updatedAt}</dd></dl><div className="inline-form">{nextLabel ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void advance()}>{nextLabel}</button> : null}<button className="button" type="button" disabled={submitting} onClick={() => void labelInfo()}>讀取標籤列印參照</button></div>{label ? <p>標籤列印參照：<code>{label.labelReference}</code>（僅為不透明參照，非公開網址。）</p> : null}{operation ? <ShipmentOperationDetail operation={operation} submitting={submitting} onRetry={() => void retry()} /> : shipment.provider === 'ecpay-logistics' ? <p className="muted">尚無綠界物流建單作業紀錄。</p> : null}</div> : null}
    {ecpayInstalled ? <FailedShipmentOperations operations={failedOperations} onInspect={(id) => setShipmentId(id)} /> : null}
  </section>;
}

function ShipmentOperationDetail({ operation, submitting, onRetry }: { operation: EcpayLogisticsShipmentOperation; submitting: boolean; onRetry: () => void }) {
  const retryable = operation.status === 'failed' && Boolean(operation.jobId);
  return <section aria-label="綠界物流作業紀錄"><h3>綠界物流建單作業</h3><dl className="order-totals"><dt>作業狀態</dt><dd><StatusBadge value={operation.status} /></dd><dt>嘗試次數</dt><dd>{operation.attempts}</dd><dt>手動重試</dt><dd>{operation.manualRetries}</dd><dt>失敗原因</dt><dd><span className="cell-truncate" title={operation.lastError ?? undefined}>{operation.lastError ?? '—'}</span></dd><dt>首次記錄</dt><dd>{operation.firstSeenAt}</dd><dt>作業更新</dt><dd>{operation.updatedAt}</dd><dt>最近狀態查詢</dt><dd>{operation.lastStatusQueriedAt ?? '—'}</dd><dt>狀態查詢錯誤</dt><dd><span className="cell-truncate" title={operation.lastStatusQueryError ?? undefined}>{operation.lastStatusQueryError ?? '—'}</span></dd></dl>{retryable ? <button className="button button--primary" type="button" disabled={submitting} onClick={onRetry}>重試綠界物流建單</button> : operation.status === 'failed' ? <p className="muted">此失敗作業尚有自動重試或不具可重試的死信工作，不能手動重送。</p> : null}</section>;
}

function FailedShipmentOperations({ operations, onInspect }: { operations: EcpayLogisticsShipmentOperation[]; onInspect: (shipmentId: string) => void }) {
  return <section aria-label="失敗的綠界物流作業"><h3>失敗的綠界物流作業</h3>{operations.length === 0 ? <p className="muted">目前沒有失敗的綠界物流建單作業。</p> : <ul>{operations.map((operation) => <li key={operation.shipmentId}><code>{operation.shipmentId}</code>：{operation.lastError ?? '未提供失敗原因'}（{operation.updatedAt}） <button className="button" type="button" onClick={() => onInspect(operation.shipmentId)}>帶入查詢</button></li>)}</ul>}</section>;
}
