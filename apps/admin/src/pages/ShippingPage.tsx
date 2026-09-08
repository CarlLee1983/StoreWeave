import { useEffect, useRef, useState, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EcpayLogisticsShipmentOperation, type Order, type Shipment, type ShipmentLabelInfo, type ShippingMethod } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog';
import { useI18n } from '../i18n';
import { extensionKeys, orderKeys, shipmentKeys, shipmentOperationKeys, shippingMethodKeys } from '../query';
import { type AdminOperationEntry, useAdminOperationEntries } from '../admin-operations';
import { isShippingOperationEntry, shippingScope, type ShippingMethodCreateDraft, type ShippingMethodUpdateDraft, type ShippingOperation, useShippingCommand } from '../shipping-operations';

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

function methodFormFromDraft(draft: ShippingMethodCreateDraft | ShippingMethodUpdateDraft, code = ''): MethodForm {
  return { code: 'code' in draft ? draft.code : code, ...draft };
}

function methodPayload(form: MethodForm, includeCode: boolean, invalidMessage: string):
  | { code: string; name: string; provider: string; type: string; destinationKind: ShippingMethod['destinationKind']; feeCents: number; freeShippingThresholdCents?: number; enabled: boolean }
  | Error {
  const feeCents = Number(form.feeCents);
  const threshold = form.freeShippingThresholdCents.trim() === '' ? undefined : Number(form.freeShippingThresholdCents);
  if (!form.name.trim() || !CODE.test(form.provider) || !CODE.test(form.type) || !Number.isInteger(feeCents) || feeCents < 0
    || (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0)) || (includeCode && !CODE.test(form.code))) {
    return new Error(invalidMessage);
  }
  return {
    ...(includeCode ? { code: form.code.trim() } : { code: '' }),
    name: form.name.trim(), provider: form.provider.trim(), type: form.type.trim(), destinationKind: form.destinationKind,
    feeCents, ...(threshold === undefined ? {} : { freeShippingThresholdCents: threshold }), enabled: form.enabled,
  };
}

export function ShippingPage() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ShippingMethod | null>(null);
  const [recoveryError, setRecoveryError] = useState<unknown>(null);

  const methodInput = { limit: 100, offset: 0 };
  const orderInput = { status: 'paid' as const, limit: 100, offset: 0 };
  const methodsQuery = useQuery({ queryKey: shippingMethodKeys.list(methodInput), queryFn: ({ signal }) => api.listShippingMethods(methodInput, signal) });
  const ordersQuery = useQuery({ queryKey: orderKeys.list(orderInput), queryFn: ({ signal }) => api.listOrders(orderInput, signal) });
  const methods = methodsQuery.isSuccess ? methodsQuery.data.items : [];
  const orders = ordersQuery.isSuccess ? ordersQuery.data.items : [];
  const operationEntries = useAdminOperationEntries();
  const recoveries = operationEntries.filter(isShippingOperationEntry);

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
    {recoveryError ? <ErrorBanner error={recoveryError} onDismiss={() => setRecoveryError(null)} /> : null}
    {recoveries.filter((entry) => entry.operation.kind === 'create-method' || entry.operation.kind === 'update-method').map((entry) => <ShippingRecovery key={entry.operation.idempotencyKey} entry={entry} onTerminalError={setRecoveryError} />)}
    {methodsQuery.isError ? <ErrorBanner error={methodsQuery.error} onRetry={() => void methodsQuery.refetch()} /> : null}
    {ordersQuery.isError ? <ErrorBanner error={ordersQuery.error} onRetry={() => void ordersQuery.refetch()} /> : null}
    {methodsQuery.isLoading ? <Loading /> : methodsQuery.isSuccess ? <ShippingMethodList methods={methods} onEdit={setEditing} /> : null}
    {ordersQuery.isLoading ? <Loading /> : null}
    <ShipmentWorkbench orders={orders.filter((order) => Boolean(order.delivery))} ordersReady={ordersQuery.isSuccess} onTerminalError={setRecoveryError} />
    {creating ? <CreateMethodDrawer onClose={() => setCreating(false)} /> : null}
    {editing ? <EditMethodDrawer method={editing} onClose={() => setEditing(null)} /> : null}
  </section>;
}

function ShippingRecovery({ entry, onConfirmed, onTerminalError }: { entry: AdminOperationEntry<ShippingOperation>; onConfirmed?: (result: unknown) => void; onTerminalError: (error: unknown) => void }) {
  const { t, statusLabel } = useI18n();
  const command = useShippingCommand();
  const [submitting, setSubmitting] = useState(false);
  const retry = async () => { setSubmitting(true); const result = await command(entry.operation, entry); if (result.state === 'success') onConfirmed?.(result.result); if (result.state === 'rejected') onTerminalError(result.error); setSubmitting(false); };
  const operation = entry.operation;
  const preview = operation.kind === 'create-method' ? <><dt>{t('createShippingMethod')}</dt><dd>{operation.draft.name}</dd><dt>{t('shippingFeeCents')}</dt><dd className="mono">{operation.draft.feeCents}</dd><dt>{t('freeShippingThresholdCents')}</dt><dd className="mono">{operation.draft.freeShippingThresholdCents || '—'}</dd></>
    : operation.kind === 'update-method' ? <><dt>{t('edit')}</dt><dd className="mono">{operation.methodId}</dd><dt>{t('shippingFeeCents')}</dt><dd className="mono">{operation.draft.feeCents}</dd><dt>{t('freeShippingThresholdCents')}</dt><dd className="mono">{operation.draft.freeShippingThresholdCents || '—'}</dd></>
      : operation.kind === 'create-shipment' ? <><dt>{t('paidOrder')}</dt><dd className="mono">{operation.draft.orderId}</dd><dt>{t('createShipment')}</dt><dd>{t('shipmentWorkbench')}</dd></>
        : operation.kind === 'advance-shipment' ? <><dt>{t('shipmentId')}</dt><dd className="mono">{operation.shipmentId}</dd><dt>{t('status')}</dt><dd>{statusLabel(operation.draft.status)}</dd></>
          : <><dt>{t('shipmentId')}</dt><dd className="mono">{operation.shipmentId}</dd><dt>{t('retryEcpayShipment')}</dt><dd>{t('ecpayShipmentOperation')}</dd></>;
  return <section className="account-panel" aria-label={t('shipmentWorkbench')}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('productOperationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}</div><dl className="order-totals">{preview}</dl></section>;
}

function MethodFields({ form, onChange, immutableCode = false, locked = false, codeRef, nameRef }: { form: MethodForm; onChange: <K extends keyof MethodForm>(key: K, value: MethodForm[K]) => void; immutableCode?: boolean; locked?: boolean; codeRef?: Ref<HTMLInputElement>; nameRef?: Ref<HTMLInputElement> }) {
  const { t } = useI18n();
  return <div className="drawer-form-body">
    <div className="form-field">
      <label htmlFor="shipping-method-code"><span className="field-label-text">{t('code')}</span></label>
      <input id="shipping-method-code" ref={codeRef} aria-label={t('shippingCode')} className="mono" disabled={immutableCode || locked} value={form.code} onChange={(event) => onChange('code', event.target.value)} />
    </div>
    <div className="form-field">
      <label htmlFor="shipping-method-name"><span className="field-label-text">{t('name')}</span></label>
        <input id="shipping-method-name" ref={nameRef} aria-label={t('shippingName')} readOnly={locked} value={form.name} onChange={(event) => onChange('name', event.target.value)} />
    </div>
    <div className="form-grid-2">
      <div className="form-field">
        <label htmlFor="shipping-method-provider"><span className="field-label-text">{t('provider')}</span></label>
        <input id="shipping-method-provider" aria-label={t('provider')} readOnly={locked} value={form.provider} onChange={(event) => onChange('provider', event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="shipping-method-type"><span className="field-label-text">{t('shippingType')}</span></label>
        <input id="shipping-method-type" aria-label={t('shippingType')} readOnly={locked} value={form.type} onChange={(event) => onChange('type', event.target.value)} />
      </div>
    </div>
    <div className="form-field">
      <label htmlFor="shipping-method-destination"><span className="field-label-text">{t('destination')}</span></label>
      <select id="shipping-method-destination" aria-label={t('destination')} disabled={locked} value={form.destinationKind} onChange={(event) => onChange('destinationKind', event.target.value as MethodForm['destinationKind'])}>
        <option value="taiwan_home">{t('taiwanHome')}</option>
        <option value="pickup_store">{t('pickupStore')}</option>
      </select>
    </div>
    <div className="form-grid-2">
      <div className="form-field">
        <label htmlFor="shipping-method-fee"><span className="field-label-text">{t('shippingFeeCents')}</span></label>
        <input id="shipping-method-fee" aria-label={t('shippingFeeCents')} className="mono" readOnly={locked} value={form.feeCents} onChange={(event) => onChange('feeCents', event.target.value)} />
      </div>
      <div className="form-field">
        <label htmlFor="shipping-method-threshold"><span className="field-label-text">{t('freeShippingThresholdCents')}</span></label>
        <input id="shipping-method-threshold" aria-label={t('freeShippingThresholdCents')} className="mono" readOnly={locked} value={form.freeShippingThresholdCents} onChange={(event) => onChange('freeShippingThresholdCents', event.target.value)} />
      </div>
    </div>
    <label className="checkbox"><input aria-label={t('enableShippingMethod')} type="checkbox" disabled={locked} checked={form.enabled} onChange={(event) => onChange('enabled', event.target.checked)} /> {t('enable')}</label>
  </div>;
}

/** 建立配送方式抽屜：版型比照 ProductsPage 的 CreateProductDrawer。 */
function CreateMethodDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const command = useShippingCommand();
  const recovery = useAdminOperationEntries().filter(isShippingOperationEntry).find((entry) => entry.operation.scope === shippingScope.methodCreate) ?? null;
  const [form, setForm] = useState<MethodForm>(() => recovery?.operation.kind === 'create-method' ? methodFormFromDraft(recovery.operation.draft) : EMPTY_METHOD);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const update = <K extends keyof MethodForm>(key: K, value: MethodForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const payload = methodPayload(form, true, t('invalidShippingMethod'));
    if (payload instanceof Error) { setError(payload); return; }
    setSubmitting(true); setError(null);
    try { const result = await command({ area: 'shipping', scope: shippingScope.methodCreate, kind: 'create-method', request: payload, draft: { ...form }, idempotencyKey: crypto.randomUUID() }, recovery?.operation.kind === 'create-method' ? recovery : undefined); if (result.state === 'success') onClose(); else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error); }
    finally { setSubmitting(false); }
  };
  const retryRecovery = async () => {
    if (!recovery || recovery.phase !== 'unknown') return;
    setSubmitting(true); setError(null);
    const result = await command(recovery.operation, recovery);
    if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="ui-product-sheet" onOpenAutoFocus={(event) => { event.preventDefault(); (recovery ? cancelRef : codeRef).current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}>
        <header className="product-drawer-header">
          <div><DialogTitle>{t('createShippingMethod')}</DialogTitle></div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>
        <form className="form-panel product-drawer-form" aria-label={t('createShippingMethod')} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          <MethodFields form={form} onChange={update} locked={!!recovery} codeRef={codeRef} />
          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>{t('cancel')}</button>
            {recovery?.phase === 'unknown' ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void retryRecovery()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={submitting || !!recovery}>{submitting ? t('creatingShippingMethod') : t('createShippingMethod')}</button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShippingMethodList({ methods, onEdit }: { methods: ShippingMethod[]; onEdit: (method: ShippingMethod) => void }) {
  const { t } = useI18n();
  return <section className="account-panel" aria-label={t('shippingMethodList')}>
    <div className="section-heading"><h2>{t('shippingMethods')}</h2><p>{t('shippingMethodSnapshotHint')}</p></div>
    {methods.length === 0 ? <EmptyState icon="truck" title={t('noShippingMethods')} hint={t('noShippingMethodsHint')} /> : <div className="table-wrap"><table className="data-table data-table--fixed shipping-methods-table"><thead><tr>
      <th style={{ width: '13%' }}>{t('code')}</th>
      <th style={{ width: '17%' }}>{t('name')}</th>
      <th style={{ width: '16%' }} title={`${t('provider')} / ${t('shippingType')}`}>{t('provider')} / {t('shippingType')}</th>
      <th style={{ width: '13%' }}>{t('destination')}</th>
      <th style={{ width: '10%' }} className="col-numeric">{t('price')}</th>
      <th style={{ width: '11%' }} className="col-numeric">{t('freeShippingThresholdCents')}</th>
      <th style={{ width: '9%' }}>{t('status')}</th>
      <th style={{ width: '11%' }} className="col-actions">{t('actions')}</th>
    </tr></thead><tbody>
      {methods.map((method) => <tr key={method.id}>
        <td className="mono" title={method.code}>{method.code}</td>
        <td>{method.name}</td>
        <td>{method.provider} / {method.type}</td>
        <td>{method.destinationKind === 'pickup_store' ? t('pickupStore') : t('taiwanHome')}</td>
        <td className="col-numeric">{method.feeCents}</td>
        <td className="col-numeric">{method.freeShippingThresholdCents ?? '—'}</td>
        <td><StatusBadge value={method.enabled ? 'active' : 'disabled'} /></td>
        <td className="col-actions"><button className="button button--quiet" type="button" onClick={() => onEdit(method)}><Icon name="pencil" /> {t('edit')}</button></td>
      </tr>)}
    </tbody></table></div>}
  </section>;
}

/** 編輯配送方式抽屜：與建立共用同一套欄位，代碼建立後不可更改。 */
function EditMethodDrawer({ method, onClose }: { method: ShippingMethod; onClose: () => void }) {
  const { t } = useI18n();
  const command = useShippingCommand();
  const recovery = useAdminOperationEntries().filter(isShippingOperationEntry).find((entry) => entry.operation.scope === shippingScope.method(method.id)) ?? null;
  const [form, setForm] = useState<MethodForm>(() => recovery?.operation.kind === 'update-method' ? methodFormFromDraft(recovery.operation.draft, method.code) : methodFormOf(method));
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const update = <K extends keyof MethodForm>(key: K, value: MethodForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const payload = methodPayload(form, false, t('invalidShippingMethod'));
    if (payload instanceof Error) { setError(payload); return; }
    const { code: _code, ...updatePayload } = payload;
    setSubmitting(true); setError(null);
    try {
      const request = { ...updatePayload, freeShippingThresholdCents: form.freeShippingThresholdCents.trim() === '' ? null : updatePayload.freeShippingThresholdCents };
      const draft: ShippingMethodUpdateDraft = { name: form.name, provider: form.provider, type: form.type, destinationKind: form.destinationKind, feeCents: form.feeCents, freeShippingThresholdCents: form.freeShippingThresholdCents, enabled: form.enabled };
      const result = await command({ area: 'shipping', scope: shippingScope.method(method.id), kind: 'update-method', methodId: method.id, request, draft, idempotencyKey: crypto.randomUUID() }, recovery?.operation.kind === 'update-method' ? recovery : undefined);
      if (result.state === 'success') onClose(); else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } finally { setSubmitting(false); }
  };
  const retryRecovery = async () => {
    if (!recovery || recovery.phase !== 'unknown') return;
    setSubmitting(true); setError(null);
    const result = await command(recovery.operation, recovery);
    if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="ui-product-sheet" onOpenAutoFocus={(event) => { event.preventDefault(); (recovery ? cancelRef : nameRef).current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}>
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('edit')} {method.name}</DialogTitle>
            <p className="product-drawer-sku">{t('code')}：<span className="mono">{method.code}</span></p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>
        <form className="form-panel product-drawer-form" aria-label={`${t('edit')} ${method.name}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          <MethodFields form={form} onChange={update} immutableCode locked={!!recovery} nameRef={nameRef} />
          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>{t('cancel')}</button>
            {recovery?.phase === 'unknown' ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void retryRecovery()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={submitting || !!recovery}>{submitting ? t('loading') : t('saveChanges')}</button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShipmentWorkbench({ orders, ordersReady, onTerminalError }: { orders: Order[]; ordersReady: boolean; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useShippingCommand();
  const queryClient = useQueryClient();
  const operationEntries = useAdminOperationEntries();
  const recoveries = operationEntries.filter(isShippingOperationEntry);
  const [orderId, setOrderId] = useState('');
  const [shipmentId, setShipmentId] = useState('');
  const [selectedShipmentId, setSelectedShipmentId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const extensionsQuery = useQuery({ queryKey: extensionKeys.list, queryFn: ({ signal }) => api.listExtensions(signal) });
  const ecpayInstalled = extensionsQuery.isSuccess && extensionsQuery.data.items.some((extension) => extension.id === 'ecpay-logistics');
  const shipmentQuery = useQuery({ queryKey: shipmentKeys.detail(selectedShipmentId), queryFn: ({ signal }) => api.getShipment(selectedShipmentId, signal), enabled: Boolean(selectedShipmentId) });
  const shipment = shipmentQuery.isSuccess ? shipmentQuery.data : null;
  const operationQuery = useQuery({ queryKey: shipmentOperationKeys.detail(selectedShipmentId), queryFn: ({ signal }) => api.getEcpayLogisticsShipmentOperation(selectedShipmentId, signal), enabled: ecpayInstalled && shipment?.provider === 'ecpay-logistics' });
  const operation = operationQuery.isSuccess ? operationQuery.data : null;
  const failedOperationsQuery = useQuery({ queryKey: shipmentOperationKeys.list({ status: 'failed', limit: 50 }), queryFn: ({ signal }) => api.listEcpayLogisticsShipmentOperations({ status: 'failed', limit: 50 }, signal), enabled: ecpayInstalled });
  const labelQuery = useQuery({ queryKey: shipmentKeys.label(selectedShipmentId), queryFn: ({ signal }) => api.getShipmentLabelInfo(selectedShipmentId, signal), enabled: false });
  const inspect = () => { if (!shipmentId.trim()) { setError(new Error(t('invalidShipmentId'))); return; } setError(null); setSelectedShipmentId(shipmentId.trim()); };
  const selectShipment = (id: string, value?: Shipment) => { if (value) queryClient.setQueryData(shipmentKeys.detail(id), value); setShipmentId(id); setSelectedShipmentId(id); };
  const create = async () => { if (!orderId) { setError(new Error(t('invalidOrderForShipment'))); return; } setSubmitting(true); setError(null); try { const occupancy = operationEntries.find((entry) => entry.operation.scope === shippingScope.order(orderId)); const recovery = occupancy && isShippingOperationEntry(occupancy) && occupancy.operation.kind === 'create-shipment' ? occupancy : undefined; const result = await command({ area: 'shipping', scope: shippingScope.order(orderId), kind: 'create-shipment', orderId, request: { orderId }, draft: { orderId }, idempotencyKey: crypto.randomUUID() }, recovery); if (result.state === 'success' && 'shippingMethodId' in result.result) selectShipment(result.result.id, result.result); else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error); } finally { setSubmitting(false); } };
  const advance = async () => { const next = shipment?.status === 'created' ? 'shipped' : shipment?.status === 'shipped' ? 'arrived' : shipment?.status === 'arrived' ? 'completed' : null; if (!shipment || !next) return; setSubmitting(true); setError(null); try { const occupancy = operationEntries.find((entry) => entry.operation.scope === shippingScope.shipment(shipment.id)); const recovery = occupancy && isShippingOperationEntry(occupancy) && occupancy.operation.kind === 'advance-shipment' ? occupancy : undefined; const result = await command({ area: 'shipping', scope: shippingScope.shipment(shipment.id), kind: 'advance-shipment', shipmentId: shipment.id, request: { status: next }, draft: { status: next }, idempotencyKey: crypto.randomUUID() }, recovery); if (result.state === 'success' && 'shippingMethodId' in result.result) queryClient.setQueryData(shipmentKeys.detail(shipment.id), result.result); else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error); } finally { setSubmitting(false); } };
  const labelInfo = async () => { if (!shipment) return; setSubmitting(true); setError(null); await labelQuery.refetch().catch((reason) => setError(reason)); setSubmitting(false); };
  const retry = async () => {
    if (!operation || operation.status !== 'failed' || !operation.jobId) return;
    setSubmitting(true); setError(null);
    try { const occupancy = operationEntries.find((entry) => entry.operation.scope === shippingScope.shipment(operation.shipmentId)); const recovery = occupancy && isShippingOperationEntry(occupancy) && occupancy.operation.kind === 'retry-ecpay' ? occupancy : undefined; const result = await command({ area: 'shipping', scope: shippingScope.shipment(operation.shipmentId), kind: 'retry-ecpay', shipmentId: operation.shipmentId, request: { shipmentId: operation.shipmentId }, draft: {}, idempotencyKey: crypto.randomUUID() }, recovery); if (result.state === 'success' && 'manualRetries' in result.result) queryClient.setQueryData(shipmentOperationKeys.detail(operation.shipmentId), result.result); else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error); }
    finally { setSubmitting(false); }
  };
  const recovered = async (entry: AdminOperationEntry<ShippingOperation>, result: unknown) => {
    if (entry.operation.kind === 'create-shipment' && result && typeof result === 'object' && 'shippingMethodId' in result) {
      const created = result as Shipment;
      selectShipment(created.id, created);
    }
    if (entry.operation.kind === 'advance-shipment' && result && typeof result === 'object' && 'shippingMethodId' in result) queryClient.setQueryData(shipmentKeys.detail(entry.operation.shipmentId), result as Shipment);
    if (entry.operation.kind === 'retry-ecpay' && result && typeof result === 'object' && 'manualRetries' in result) queryClient.setQueryData(shipmentOperationKeys.detail(entry.operation.shipmentId), result as EcpayLogisticsShipmentOperation);
  };
  const nextLabel = shipment?.status === 'created' ? t('markShipped') : shipment?.status === 'shipped' ? t('markArrived') : shipment?.status === 'arrived' ? t('markCompleted') : null;
  const shipmentOccupied = shipment ? operationEntries.some((entry) => entry.operation.scope === shippingScope.shipment(shipment.id)) : false;
  return <section className="account-panel" aria-label={t('shipmentWorkbench')}><div className="section-heading"><h2>{t('shipmentWorkbench')}</h2><p>{t('shipmentWorkbenchHint')}</p></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {extensionsQuery.isError ? <ErrorBanner error={extensionsQuery.error} onRetry={() => void extensionsQuery.refetch()} /> : null}
    <div className="inline-form"><label>{t('paidOrder')}<select aria-label={t('paidOrder')} value={orderId} disabled={!ordersReady || operationEntries.some((entry) => entry.operation.scope === shippingScope.order(orderId))} onChange={(event) => setOrderId(event.target.value)}><option value="">{t('selectOrder')}</option>{orders.map((order) => <option key={order.id} value={order.id}>{order.number} · {order.delivery!.shippingMethodName}</option>)}</select></label><button className="button button--primary" type="button" disabled={!ordersReady || submitting || operationEntries.some((entry) => entry.operation.scope === shippingScope.order(orderId))} onClick={() => void create()}>{t('createShipment')}</button></div>
    <div className="inline-form"><label>{t('shipmentId')}<input aria-label={t('shipmentId')} value={shipmentId} onChange={(event) => setShipmentId(event.target.value)} /></label><button className="button" type="button" disabled={submitting} onClick={inspect}>{t('findShipment')}</button></div>
    {shipmentQuery.isError ? <ErrorBanner error={shipmentQuery.error} onRetry={() => void shipmentQuery.refetch()} /> : null}
    {shipmentQuery.isLoading ? <Loading /> : null}
    {shipment ? <div className="order-detail"><dl className="order-totals"><dt>{t('status')}</dt><dd><StatusBadge value={shipment.status} /></dd><dt>{t('provider')}</dt><dd>{shipment.provider} / {shipment.type}</dd><dt>{t('providerReference')}</dt><dd className="mono"><span className="cell-truncate" title={shipment.providerRef ?? undefined}>{shipment.providerRef ?? '—'}</span></dd><dt>{t('trackingNumber')}</dt><dd className="mono"><span className="cell-truncate" title={shipment.trackingNumber ?? undefined}>{shipment.trackingNumber ?? '—'}</span></dd><dt>{t('createdAt')}</dt><dd>{shipment.createdAt}</dd><dt>{t('lastUpdated')}</dt><dd>{shipment.updatedAt}</dd></dl><div className="inline-form">{nextLabel ? <button className="button button--primary" type="button" disabled={submitting || shipmentOccupied} onClick={() => void advance()}>{nextLabel}</button> : null}<button className="button" type="button" disabled={submitting} onClick={() => void labelInfo()}>{t('retrieveLabelReference')}</button></div>{labelQuery.isError ? <ErrorBanner error={labelQuery.error} onRetry={() => void labelQuery.refetch()} /> : null}{labelQuery.isSuccess && labelQuery.data ? <p>{t('labelReference')}：<code>{labelQuery.data.labelReference}</code>（{t('labelReferenceNotice')}）</p> : null}{operationQuery.isError ? <ErrorBanner error={operationQuery.error} onRetry={() => void operationQuery.refetch()} /> : null}{operationQuery.isLoading ? <Loading /> : null}{operation ? <ShipmentOperationDetail operation={operation} submitting={submitting || shipmentOccupied} onRetry={() => void retry()} /> : operationQuery.isSuccess && shipment.provider === 'ecpay-logistics' ? <p className="muted">{t('noEcpayShipmentOperation')}</p> : null}</div> : null}
    {recoveries.filter((entry) => entry.operation.kind === 'create-shipment' || entry.operation.kind === 'advance-shipment' || entry.operation.kind === 'retry-ecpay').map((entry) => <ShippingRecovery key={entry.operation.idempotencyKey} entry={entry} onConfirmed={(result) => void recovered(entry, result)} onTerminalError={onTerminalError} />)}
    {failedOperationsQuery.isError ? <ErrorBanner error={failedOperationsQuery.error} onRetry={() => void failedOperationsQuery.refetch()} /> : null}
    {failedOperationsQuery.isLoading ? <Loading /> : null}
    {failedOperationsQuery.isSuccess ? <FailedShipmentOperations operations={failedOperationsQuery.data.items} onInspect={(id) => selectShipment(id)} /> : null}
  </section>;
}

function ShipmentOperationDetail({ operation, submitting, onRetry }: { operation: EcpayLogisticsShipmentOperation; submitting: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  const retryable = operation.status === 'failed' && Boolean(operation.jobId);
  return <section aria-label={t('ecpayShipmentOperation')}><h3>{t('ecpayShipmentOperation')}</h3><dl className="order-totals"><dt>{t('operationStatus')}</dt><dd><StatusBadge value={operation.status} /></dd><dt>{t('attempts')}</dt><dd>{operation.attempts}</dd><dt>{t('manualResends')}</dt><dd>{operation.manualRetries}</dd><dt>{t('failureReason')}</dt><dd><span className="cell-truncate" title={operation.lastError ?? undefined}>{operation.lastError ?? '—'}</span></dd><dt>{t('firstRecordedAt')}</dt><dd>{operation.firstSeenAt}</dd><dt>{t('operationUpdatedAt')}</dt><dd>{operation.updatedAt}</dd><dt>{t('lastStatusQuery')}</dt><dd>{operation.lastStatusQueriedAt ?? '—'}</dd><dt>{t('statusQueryError')}</dt><dd><span className="cell-truncate" title={operation.lastStatusQueryError ?? undefined}>{operation.lastStatusQueryError ?? '—'}</span></dd></dl>{retryable ? <button className="button button--primary" type="button" disabled={submitting} onClick={onRetry}>{t('retryEcpayShipment')}</button> : operation.status === 'failed' ? <p className="muted">{t('noManualRetryEcpay')}</p> : null}</section>;
}

function FailedShipmentOperations({ operations, onInspect }: { operations: EcpayLogisticsShipmentOperation[]; onInspect: (shipmentId: string) => void }) {
  const { t } = useI18n();
  return <section aria-label={t('failedEcpayShipmentOperations')}><h3>{t('failedEcpayShipmentOperations')}</h3>{operations.length === 0 ? <p className="muted">{t('noFailedEcpayShipmentOperations')}</p> : <ul>{operations.map((operation) => <li key={operation.shipmentId}><code>{operation.shipmentId}</code>：{operation.lastError ?? t('noFailureReasonProvided')}（{operation.updatedAt}） <button className="button" type="button" onClick={() => onInspect(operation.shipmentId)}>{t('inspectShipment')}</button></li>)}</ul>}</section>;
}
