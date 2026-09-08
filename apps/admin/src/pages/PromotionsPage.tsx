import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Promotion, type PromotionRule } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { DateTimeField } from '../components/DateTimeField';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog';
import { analyticsKeys, promotionKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

/** 規則型別在編譯期已知，每一種有自己的表單欄位——折扣設定需要客製 UI，不做 schema 驅動的動態表單。 */
const RULE_TYPES = ['threshold_fixed_amount', 'threshold_percentage', 'order_percentage'] as const;
type RuleType = (typeof RULE_TYPES)[number];

const hasThreshold = (type: RuleType) => type !== 'order_percentage';
const hasPercent = (type: RuleType) => type !== 'threshold_fixed_amount';

/** ISO ⇄ `datetime-local` 的值。datetime-local 沒有時區，顯示與輸入都用瀏覽器本地時間。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface FormState {
  name: string;
  ruleType: RuleType;
  thresholdCents: string;
  discountCents: string;
  percentOff: string;
  maxDiscountCents: string;
  priority: string;
  stackable: boolean;
  requiresCoupon: boolean;
  startsAt: string;
  endsAt: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  ruleType: 'threshold_fixed_amount',
  thresholdCents: '100000',
  discountCents: '10000',
  percentOff: '10',
  maxDiscountCents: '',
  priority: '0',
  stackable: true,
  requiresCoupon: false,
  startsAt: '',
  endsAt: '',
};

function formStateOf(promotion: Promotion): FormState {
  const rule = promotion.rule;
  return {
    name: promotion.name,
    ruleType: rule.type,
    thresholdCents: 'thresholdCents' in rule ? String(rule.thresholdCents) : EMPTY_FORM.thresholdCents,
    discountCents: rule.type === 'threshold_fixed_amount' ? String(rule.discountCents) : EMPTY_FORM.discountCents,
    percentOff: 'percentOffBasisPoints' in rule ? String(rule.percentOffBasisPoints / 100) : EMPTY_FORM.percentOff,
    maxDiscountCents:
      'maxDiscountCents' in rule && rule.maxDiscountCents !== null && rule.maxDiscountCents !== undefined
        ? String(rule.maxDiscountCents)
        : '',
    priority: String(promotion.priority),
    stackable: promotion.stackable,
    requiresCoupon: promotion.requiresCoupon,
    startsAt: toLocalInput(promotion.startsAt),
    endsAt: toLocalInput(promotion.endsAt),
  };
}

export interface PromotionPayload {
  name: string;
  rule: PromotionRule;
  priority: number;
  stackable: boolean;
  requiresCoupon: boolean;
  startsAt?: string;
  endsAt?: string;
}

type PromotionOperation = AdminOperation & (
  | { kind: 'create'; request: PromotionPayload; draft: FormState }
  | { kind: 'edit'; promotionId: string; request: PromotionPayload; draft: FormState }
  | { kind: 'status'; promotionId: string; request: { status: Promotion['status'] }; preview: { name: string; status: Promotion['status'] } }
);
type PromotionOperationEntry = AdminOperationEntry<PromotionOperation>;
type PromotionOperationResult = Awaited<ReturnType<typeof executeAdminOperation<PromotionOperation, Promotion>>>;
type RunPromotionOperation = (operation: PromotionOperation, retryEntry?: PromotionOperationEntry) => Promise<PromotionOperationResult>;

function isPromotionOperation(entry: AdminOperationEntry): entry is PromotionOperationEntry {
  return entry.operation.area === 'promotion' && ['create', 'edit', 'status'].includes((entry.operation as PromotionOperation).kind);
}
function promotionPreview(operation: PromotionOperation) {
  if (operation.kind === 'status') return `${operation.preview.name} · ${operation.request.status}`;
  return operation.kind === 'create' ? operation.request.name : operation.request.name;
}

/**
 * 經營者填的是百分比與整數分，契約收的是基點——換算與驗證留在這裡，
 * 畫面不出現「基點」這個詞。回傳 Error 表示這份表單不該送出。
 */
function toPayload(form: FormState, t: (key: MessageKey) => string): PromotionPayload | Error {
  const threshold = Number(form.thresholdCents);
  const priority = Number(form.priority);
  const basisPoints = Math.round(Number(form.percentOff) * 100);
  const max = form.maxDiscountCents.trim() === '' ? null : Number(form.maxDiscountCents);
  const invalid = new Error(t('invalidPromotion'));

  if (!form.name.trim() || !Number.isInteger(priority)) return invalid;
  // 後端也會擋，但先在這裡說清楚是哪一個欄位錯，不然只會拿到一個泛用錯誤。
  if (form.startsAt && form.endsAt && new Date(form.endsAt).getTime() <= new Date(form.startsAt).getTime()) {
    return new Error(t('invalidPeriod'));
  }
  if (form.thresholdCents.trim() === '' && hasThreshold(form.ruleType)) return invalid;
  if (hasThreshold(form.ruleType) && (!Number.isInteger(threshold) || threshold < 0)) return invalid;
  if (max !== null && (!Number.isInteger(max) || max < 0)) return invalid;

  let rule: PromotionRule;
  if (form.ruleType === 'threshold_fixed_amount') {
    const discount = Number(form.discountCents);
    if (!Number.isInteger(discount) || discount <= 0) return invalid;
    rule = { type: form.ruleType, thresholdCents: threshold, discountCents: discount };
  } else {
    if (!Number.isInteger(basisPoints) || basisPoints <= 0 || basisPoints > 10_000) {
      return new Error(t('invalidPercent'));
    }
    rule =
      form.ruleType === 'threshold_percentage'
        ? { type: form.ruleType, thresholdCents: threshold, percentOffBasisPoints: basisPoints, maxDiscountCents: max }
        : { type: form.ruleType, percentOffBasisPoints: basisPoints, maxDiscountCents: max };
  }

  return {
    name: form.name.trim(),
    rule,
    priority,
    stackable: form.stackable,
    requiresCoupon: form.requiresCoupon,
    startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined,
    endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined,
  };
}

export function PromotionsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const operations = useAdminOperations();
  const operationEntries = useAdminOperationEntries().filter(isPromotionOperation);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingPromotion, setEditingPromotion] = useState<Promotion | null>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const limit = 100;

  const input = { status: status || undefined, limit, offset: 0 };
  const promotionsQuery = useQuery({ queryKey: promotionKeys.list(input), queryFn: ({ signal }) => api.listPromotions(input, signal) });
  const promotions = promotionsQuery.data?.items ?? [];
  const total = promotionsQuery.data?.total ?? 0;
  const reload = () => void promotionsQuery.refetch();
  const inspectOperation = (entry: PromotionOperationEntry) => {
    if (entry.operation.kind === 'create') setCreating(true);
    if (entry.operation.kind === 'edit') {
      const operation = entry.operation;
      setEditingPromotion(promotions.find((promotion) => promotion.id === operation.promotionId) ?? {
        id: operation.promotionId, name: operation.request.name, rule: operation.request.rule, priority: operation.request.priority,
        stackable: operation.request.stackable, requiresCoupon: operation.request.requiresCoupon, autoIssue: null, autoIssueValidDays: null,
        startsAt: operation.request.startsAt ?? null, endsAt: operation.request.endsAt ?? null, status: 'disabled', createdAt: '', updatedAt: '',
      });
    }
  };
  const commandMutation = useMutation<Promotion, unknown, PromotionOperation>({
    mutationFn: (operation) => {
      switch (operation.kind) {
        case 'create': return api.createPromotion(operation.request, operation.idempotencyKey);
        case 'edit': return api.updatePromotion(operation.promotionId, operation.request, operation.idempotencyKey);
        case 'status': return api.setPromotionStatus(operation.promotionId, operation.request.status, operation.idempotencyKey);
      }
    },
  });
  const runOperation: RunPromotionOperation = (operation, retryEntry) => executeAdminOperation(
    operations, operation, (live) => commandMutation.mutateAsync(live),
    (_result, live) => {
      void queryClient.invalidateQueries({ queryKey: promotionKeys.lists });
      if (live.kind === 'edit') void queryClient.invalidateQueries({ queryKey: analyticsKeys.promotionPerformances });
      return undefined;
    }, retryEntry,
  );
  const retryOperation = async (entry: PromotionOperationEntry) => {
    const result = await runOperation(entry.operation, entry);
    if (result.state === 'rejected') setOperationError(result.error);
  };

  // 頁首那顆「+ 建立活動」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開抽屜，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => {
      event.preventDefault();
      setCreating(true);
    };
    window.addEventListener('admin:action:create-promotion', openCreate);
    return () => window.removeEventListener('admin:action:create-promotion', openCreate);
  }, []);

  return (
    <section>
      {promotionsQuery.isError ? <ErrorBanner error={promotionsQuery.error} onRetry={reload} /> : null}
      {operationError ? <ErrorBanner error={operationError} onDismiss={() => setOperationError(null)} /> : null}
      {operationEntries.map((entry) => <div className="error-banner" role="status" key={entry.operation.idempotencyKey}>
        <span>{entry.operation.kind === 'create' ? `${t('createPromotion')}: ${promotionPreview(entry.operation)}` : entry.operation.kind === 'edit' ? `${t('edit')}: ${promotionPreview(entry.operation)}` : `${t('status')}: ${entry.operation.preview.name} · ${t(entry.operation.request.status as MessageKey)}`}</span>
        {entry.error instanceof Error ? <span>{entry.error.message}</span> : null}
        {entry.phase === 'unknown' && (entry.operation.kind === 'create' || entry.operation.kind === 'edit') ? <button type="button" className="button button--quiet" onClick={() => inspectOperation(entry)}>{t('inspectOriginalOperation')}</button> : null}
        {entry.phase === 'unknown' ? <button type="button" className="button button--quiet" onClick={() => void retryOperation(entry)}>{t('retryOriginalOperation')}</button> : null}
      </div>)}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('active')}</option>
          <option value="disabled">{t('disabled')}</option>
        </select>
        {/* 超出一頁時要說出來，不然第 101 檔活動在後台就是憑空消失 */}
        {total > promotions.length ? <span>{`${promotions.length} / ${total}`}</span> : null}
      </div>

      {promotionsQuery.isLoading ? (
        <Loading />
      ) : promotionsQuery.isSuccess && promotions.length === 0 ? (
        <EmptyState icon="sparkles" title={t('noPromotions')} hint="建立滿額折或整單折扣，設定期間與優先序後即可上線。" />
      ) : promotionsQuery.isSuccess ? (
        <div className="table-wrap">
          <table className="data-table data-table--fixed promotions-table">
            <thead>
              <tr>
                <th style={{ width: '26%' }}>{t('promotionName')}</th>
                <th style={{ width: '14%' }}>{t('ruleType')}</th>
                <th style={{ width: '18%' }}>{t('period')}</th>
                <th style={{ width: '8%' }} className="col-numeric">{t('priority')}</th>
                <th style={{ width: '8%' }}>{t('stackableShort')}</th>
                <th style={{ width: '12%' }}>{t('status')}</th>
                <th style={{ width: '14%' }} className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {promotions.map((promotion) => (
                <PromotionRow
                  key={promotion.id}
                  promotion={promotion}
                  onEdit={() => setEditingPromotion(promotion)}
                  onRunOperation={runOperation}
                  blocked={operationEntries.some((entry) => entry.operation.scope === `promotion:${promotion.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
        ) : null}

      {/* 建立活動抽屜 */}
      {creating ? (
        <CreatePromotionDrawer onClose={() => setCreating(false)} onRunOperation={runOperation} recovery={operationEntries.find((entry) => entry.operation.scope === 'promotion:create') ?? null} />
      ) : null}

      {/* 側邊抽屜式活動編輯器 */}
      {editingPromotion ? (
        <EditPromotionDrawer
          promotion={editingPromotion}
          onClose={() => setEditingPromotion(null)}
          onSaved={() => setEditingPromotion(null)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => entry.operation.scope === `promotion:${editingPromotion.id}`) ?? null}
        />
      ) : null}
    </section>
  );
}

function PromotionRow({
  promotion,
  onEdit,
  onRunOperation,
  blocked,
}: {
  promotion: Promotion;
  onEdit: () => void;
  onRunOperation: RunPromotionOperation;
  blocked: boolean;
}) {
  const { t, formatDateTime } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextStatus = promotion.status === 'active' ? 'disabled' : 'active';

  const toggle = async () => {
    setSubmitting(true);
    setError(null);
    const result = await onRunOperation({
      area: 'promotion', scope: `promotion:${promotion.id}`, kind: 'status', promotionId: promotion.id,
      request: { status: nextStatus }, preview: { name: promotion.name, status: nextStatus }, idempotencyKey: crypto.randomUUID(),
    });
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };

  const menuItems: RowMenuItem[] =
    promotion.status === 'active'
      ? [{ key: 'disable', label: t('disable'), icon: 'pause', onSelect: () => void toggle() }]
      : [{ key: 'enable', label: t('enable'), icon: 'play', onSelect: () => void toggle() }];

  return (
    <tr>
      <td>{promotion.name}</td>
      <td>{t(promotion.rule.type as MessageKey)}</td>
      <td className="mono">
        {promotion.startsAt ? formatDateTime(promotion.startsAt) : '—'} → {promotion.endsAt ? formatDateTime(promotion.endsAt) : '—'}
      </td>
      <td className="mono col-numeric">{promotion.priority}</td>
      <td>{promotion.stackable ? <Icon name="check" /> : '—'}</td>
      {/* 活動說「上架中」會跟商品混淆，這裡用進行中 */}
      <td><StatusBadge value={promotion.status === 'active' ? 'running' : 'disabled'} /></td>
      <td>
        <div className="product-actions-cell">
          <div className="product-actions-row">
            <button
              className="button button--quiet edit-btn"
              type="button"
              disabled={submitting || blocked}
              onClick={onEdit}
            >
              <Icon name="pencil" /> {t('edit')}
            </button>
            <RowMenu disabled={submitting || blocked} items={menuItems} />
          </div>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        </div>
      </td>
    </tr>
  );
}

function PromotionFields({
  form,
  onChange,
  nameRef,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  nameRef?: React.RefObject<HTMLInputElement>;
}) {
  const { t } = useI18n();
  return (
    <div className="form-grid">
      <label>{t('promotionName')}
        <input ref={nameRef} value={form.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>

      <label>{t('ruleType')}
        <select value={form.ruleType} onChange={(e) => onChange({ ruleType: e.target.value as RuleType })}>
          {RULE_TYPES.map((type) => <option key={type} value={type}>{t(type as MessageKey)}</option>)}
        </select>
      </label>

      {hasThreshold(form.ruleType) ? (
        <label>{t('thresholdCents')}
          <input value={form.thresholdCents} onChange={(e) => onChange({ thresholdCents: e.target.value })} inputMode="numeric" />
        </label>
      ) : null}

      {form.ruleType === 'threshold_fixed_amount' ? (
        <label>{t('discountCents')}
          <input value={form.discountCents} onChange={(e) => onChange({ discountCents: e.target.value })} inputMode="numeric" />
        </label>
      ) : null}

      {hasPercent(form.ruleType) ? (
        <>
          <label>{t('percentOff')}
            <input value={form.percentOff} onChange={(e) => onChange({ percentOff: e.target.value })} inputMode="decimal" />
          </label>
          <label>{t('maxDiscountCents')}
            <input value={form.maxDiscountCents} onChange={(e) => onChange({ maxDiscountCents: e.target.value })} inputMode="numeric" />
          </label>
        </>
      ) : null}

      <label>{t('priority')}
        <input value={form.priority} onChange={(e) => onChange({ priority: e.target.value })} inputMode="numeric" />
      </label>

      <DateTimeField
        id="promotion-starts-at"
        label={t('startsAt')}
        value={form.startsAt}
        max={form.endsAt || undefined}
        onChange={(next) => onChange({ startsAt: next })}
      />

      <DateTimeField
        id="promotion-ends-at"
        label={t('endsAt')}
        value={form.endsAt}
        min={form.startsAt || undefined}
        onChange={(next) => onChange({ endsAt: next })}
      />

      <label className="checkbox">
        <input type="checkbox" checked={form.stackable} onChange={(e) => onChange({ stackable: e.target.checked })} />
        {t('stackable')}
      </label>
      {/* 需要券的活動不會人人適用——沒有這個開關，建一張券就等於全站打折 */}
      <label className="checkbox">
        <input type="checkbox" checked={form.requiresCoupon} onChange={(e) => onChange({ requiresCoupon: e.target.checked })} />
        {t('requiresCoupon')}
      </label>
    </div>
  );
}

/** 建立活動抽屜：常駐展開的表單會佔掉清單上方一整塊，改由頁首的「+ 建立活動」開啟，版型比照商品的建立抽屜。 */
function CreatePromotionDrawer({ onClose, onRunOperation, recovery }: { onClose: () => void; onRunOperation: RunPromotionOperation; recovery: PromotionOperationEntry | null }) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = recovery !== null;

  useEffect(() => {
    if (recovery?.operation.kind === 'create') setForm(recovery.operation.draft);
  }, [recovery]);
  useEffect(() => { if (locked) cancelRef.current?.focus(); }, [locked]);

  const submit = async () => {
    const payload = toPayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onRunOperation({ area: 'promotion', scope: 'promotion:create', kind: 'create', request: payload, draft: { ...form }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'success') onClose();
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };
  const retry = async () => {
    if (!recovery) return;
    const result = await onRunOperation(recovery.operation, recovery);
    if (result.state === 'rejected') setError(result.error);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-product-sheet"
        aria-label={t('createPromotion')}
        onOpenAutoFocus={(event) => { event.preventDefault(); (locked ? cancelRef.current : nameRef.current)?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('createPromotion')}</DialogTitle>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('createPromotion')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <fieldset className="drawer-form-body" disabled={locked || submitting} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <PromotionFields form={form} nameRef={nameRef} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
          </fieldset>

          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={locked || submitting}>
              {t('createPromotion')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 側邊抽屜式活動編輯器，版型比照商品編輯抽屜。 */
function EditPromotionDrawer({
  promotion,
  onClose,
  onSaved,
  onRunOperation,
  recovery,
}: {
  promotion: Promotion;
  onClose: () => void;
  onSaved: () => void;
  onRunOperation: RunPromotionOperation;
  recovery: PromotionOperationEntry | null;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => formStateOf(promotion));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = recovery !== null;

  useEffect(() => {
    if (recovery?.operation.kind === 'edit') setForm(recovery.operation.draft);
  }, [recovery]);
  useEffect(() => { if (locked) cancelRef.current?.focus(); }, [locked]);

  const submit = async () => {
    const payload = toPayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onRunOperation({ area: 'promotion', scope: `promotion:${promotion.id}`, kind: 'edit', promotionId: promotion.id, request: payload, draft: { ...form }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'success') onSaved();
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };
  const retry = async () => {
    if (!recovery) return;
    const result = await onRunOperation(recovery.operation, recovery);
    if (result.state === 'rejected') setError(result.error);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-product-sheet"
        aria-label={`${t('edit')} ${promotion.name}`}
        onOpenAutoFocus={(event) => { event.preventDefault(); (locked ? cancelRef.current : nameRef.current)?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('edit')}</DialogTitle>
            <p className="product-drawer-sku">{promotion.name}</p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={`${t('edit')} ${promotion.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <fieldset className="drawer-form-body" disabled={locked || submitting} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <PromotionFields form={form} nameRef={nameRef} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
          </fieldset>

          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={locked || submitting}>
              {t('saveChanges')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
