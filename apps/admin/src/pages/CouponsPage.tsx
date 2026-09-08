import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Coupon, type IssueResult, type Promotion } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { DateTimeField } from '../components/DateTimeField';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog';
import { couponKeys, promotionKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

type CouponCreateRequest = Parameters<typeof api.createCoupon>[0];
type CouponIssueRequest = Parameters<typeof api.issueCoupons>[0];
type CouponCreateDraft = { code: string; promotionId: string; partnerCode: string; maxRedemptions: string; perCustomerOnce: boolean; startsAt: string; endsAt: string };
type CouponIssueDraft = { promotionId: string; codePrefix: string; expiresInDays: string };
type CouponOperation = AdminOperation & (
  | { kind: 'create'; request: CouponCreateRequest; draft: CouponCreateDraft }
  | { kind: 'issue'; request: CouponIssueRequest; draft: CouponIssueDraft; preview: { promotionName: string } }
  | { kind: 'status'; couponId: string; request: { status: Coupon['status'] }; preview: { code: string; status: Coupon['status'] } }
);
type CouponOperationEntry = AdminOperationEntry<CouponOperation>;
type CouponOperationResult = Awaited<ReturnType<typeof executeAdminOperation<CouponOperation, Coupon | IssueResult>>>;
type RunCouponOperation = (operation: CouponOperation, retryEntry?: CouponOperationEntry) => Promise<CouponOperationResult>;
function isCouponOperation(entry: AdminOperationEntry): entry is CouponOperationEntry {
  return entry.operation.area === 'coupon' && ['create', 'issue', 'status'].includes((entry.operation as CouponOperation).kind);
}

/**
 * 券的清單與管理。
 *
 * 券的「型別」不是欄位，而是兩個事實的組合：有沒有擁有者（共用碼／實發券）、
 * 有沒有合作夥伴（行銷碼）。這裡把它算出來顯示，而不是逼經營者去讀欄位。
 */
function couponKind(coupon: Coupon): 'sharedCode' | 'issuedCoupon' | 'marketingCode' {
  if (coupon.partnerCode) return 'marketingCode';
  return coupon.customerId ? 'issuedCoupon' : 'sharedCode';
}

/** 券要指向一條「需要券」的活動；人人適用的活動配上券沒有意義。 */
function couponPromotions(promotions: Promotion[]): Promotion[] {
  return promotions.filter((promotion) => promotion.requiresCoupon);
}
export function CouponsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const operations = useAdminOperations();
  const operationEntries = useAdminOperationEntries().filter(isCouponOperation);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueResult, setIssueResult] = useState<IssueResult | null>(null);
  const limit = 100;

  const couponInput = { status: status || undefined, limit, offset: 0 };
  const promotionInput = { limit, offset: 0 };
  const couponsQuery = useQuery({ queryKey: couponKeys.list(couponInput), queryFn: ({ signal }) => api.listCoupons(couponInput, signal) });
  const promotionsQuery = useQuery({ queryKey: promotionKeys.list(promotionInput), queryFn: ({ signal }) => api.listPromotions(promotionInput, signal) });
  const coupons = couponsQuery.data?.items ?? [];
  const promotions = promotionsQuery.data?.items ?? [];
  const total = couponsQuery.data?.total ?? 0;
  const selectorReady = promotionsQuery.isSuccess && !promotionsQuery.isError;
  const commandMutation = useMutation<Coupon | IssueResult, unknown, CouponOperation>({
    mutationFn: (operation) => {
      switch (operation.kind) {
        case 'create': return api.createCoupon(operation.request, operation.idempotencyKey);
        case 'issue': return api.issueCoupons(operation.request, operation.idempotencyKey);
        case 'status': return api.setCouponStatus(operation.couponId, operation.request.status, operation.idempotencyKey);
      }
    },
  });
  const runOperation: RunCouponOperation = (operation, retryEntry) => executeAdminOperation(
    operations, operation, (live) => commandMutation.mutateAsync(live),
    (result, live) => { if (live.kind === 'issue') setIssueResult(result as IssueResult); void queryClient.invalidateQueries({ queryKey: couponKeys.lists }); return undefined; }, retryEntry,
  );
  const retryOperation = async (entry: CouponOperationEntry) => {
    const result = await runOperation(entry.operation, entry);
    if (result.state === 'rejected') setOperationError(result.error);
  };
  const promotionName = (id: string) => promotions.find((p) => p.id === id)?.name ?? id;
  const inspectOperation = (entry: CouponOperationEntry) => {
    if (entry.operation.kind === 'create') setCreating(true);
    if (entry.operation.kind === 'issue') setIssuing(true);
  };

  // 頁首那顆「建立券」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開抽屜，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => {
      event.preventDefault();
      if (selectorReady) setCreating(true);
    };
    window.addEventListener('admin:action:create-coupon', openCreate);
    return () => window.removeEventListener('admin:action:create-coupon', openCreate);
  }, [selectorReady]);

  return (
    <section>
      {couponsQuery.isError ? <ErrorBanner error={couponsQuery.error} onRetry={() => void couponsQuery.refetch()} /> : null}
      {operationError ? <ErrorBanner error={operationError} onDismiss={() => setOperationError(null)} /> : null}
      {promotionsQuery.isError ? <ErrorBanner error={promotionsQuery.error} onRetry={() => void promotionsQuery.refetch()} /> : null}
      {operationEntries.map((entry) => <div className="error-banner" role="status" key={entry.operation.idempotencyKey}>
        <span>{entry.operation.kind === 'create' ? `${t('createCoupon')}: ${entry.operation.request.code}` : entry.operation.kind === 'issue' ? `${t('issueCoupons')}: ${entry.operation.request.codePrefix ?? entry.operation.preview.promotionName}` : `${t('status')}: ${entry.operation.preview.code} · ${t(entry.operation.preview.status as MessageKey)}`}</span>
        {entry.error instanceof Error ? <span>{entry.error.message}</span> : null}
        {entry.phase === 'unknown' && entry.operation.kind !== 'status' ? <button type="button" className="button button--quiet" onClick={() => inspectOperation(entry)}>{t('inspectOriginalOperation')}</button> : null}
        {entry.phase === 'unknown' ? <button type="button" className="button button--quiet" onClick={() => void retryOperation(entry)}>{t('retryOriginalOperation')}</button> : null}
      </div>)}
      {issueResult ? <p role="status">{t('issueResult')}: {issueResult.issued}（{t('skipped')}: {issueResult.skipped}）</p> : null}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="issued">{t('couponIssued')}</option>
          <option value="used">{t('couponUsed')}</option>
          <option value="void">{t('disabled')}</option>
        </select>
        {/* 超出一頁時要說出來，不然第 101 張券在後台就是憑空消失 */}
        {total > coupons.length ? <span>{`${coupons.length} / ${total}`}</span> : null}
        <button type="button" className="button button--primary" disabled={!selectorReady} onClick={() => setIssuing(true)}>
          <Icon name="send" /> {t('issueCoupons')}
        </button>
      </div>

      {couponsQuery.isLoading ? (
        <Loading />
      ) : couponsQuery.isSuccess && coupons.length === 0 ? (
        <EmptyState icon="ticket" title={t('noCoupons')} hint="建立折扣碼之後，這裡會列出它的使用狀況與有效期間。" />
      ) : couponsQuery.isSuccess ? (
        <div className="table-wrap">
          <table className="data-table data-table--fixed coupons-table">
            <thead>
              <tr>
                <th style={{ width: '16%' }}>{t('couponCode')}</th>
                <th style={{ width: '11%' }}>{t('couponKind')}</th>
                <th style={{ width: '20%' }}>{t('promotionName')}</th>
                <th style={{ width: '17%' }}>{t('period')}</th>
                <th style={{ width: '13%' }} className="col-numeric">{t('couponUsage')}</th>
                <th style={{ width: '10%' }}>{t('status')}</th>
                <th style={{ width: '13%' }} className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => (
                <CouponRow key={coupon.id} coupon={coupon} promotionName={promotionName(coupon.promotionId)} onRunOperation={runOperation} blocked={operationEntries.some((entry) => entry.operation.scope === `coupon:${coupon.id}`)} />
              ))}
            </tbody>
          </table>
        </div>
        ) : null}

      {creating ? (
        <CreateCouponDrawer
          promotions={couponPromotions(promotions)}
          selectorReady={selectorReady}
          onClose={() => setCreating(false)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => entry.operation.scope === 'coupon:create') ?? null}
        />
      ) : null}

      {issuing ? (
        <IssueCouponsDrawer
          promotions={couponPromotions(promotions)}
          selectorReady={selectorReady}
          onClose={() => setIssuing(false)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => entry.operation.scope === 'coupon:issue') ?? null}
        />
      ) : null}
    </section>
  );
}

function CouponRow({
  coupon,
  promotionName,
  onRunOperation,
  blocked,
}: {
  coupon: Coupon;
  promotionName: string;
  onRunOperation: RunCouponOperation;
  blocked: boolean;
}) {
  const { t, formatDateTime } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextStatus = coupon.status === 'void' ? 'issued' : 'void';

  const toggle = async () => {
    setSubmitting(true);
    setError(null);
    const result = await onRunOperation({ area: 'coupon', scope: `coupon:${coupon.id}`, kind: 'status', couponId: coupon.id, request: { status: nextStatus }, preview: { code: coupon.code, status: nextStatus }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };

  const menuItems: RowMenuItem[] = [{
    key: nextStatus,
    label: coupon.status === 'void' ? t('enable') : t('disable'),
    icon: coupon.status === 'void' ? 'play' : 'pause',
    onSelect: () => void toggle(),
  }];

  return (
    <tr>
      <td><span className="cell-truncate mono" title={coupon.code}>{coupon.code}</span></td>
      <td>{t(couponKind(coupon))}{coupon.partnerCode ? ` · ${coupon.partnerCode}` : ''}</td>
      <td><span className="cell-truncate" title={promotionName}>{promotionName}</span></td>
      <td className="mono" title={`${coupon.startsAt ? formatDateTime(coupon.startsAt) : '未設定開始'} → ${coupon.endsAt ? formatDateTime(coupon.endsAt) : '不限結束'}`}>
        {coupon.startsAt ? formatDateTime(coupon.startsAt) : '—'} → {coupon.endsAt ? formatDateTime(coupon.endsAt) : '—'}
      </td>
      {/* 已用 / 上限。不限量時只說用了幾次——「3 / ∞」讀起來像是壞掉的畫面 */}
      <td className="col-numeric">
        {coupon.maxRedemptions === null ? coupon.redeemedCount : `${coupon.redeemedCount} / ${coupon.maxRedemptions}`}
      </td>
      <td><StatusBadge value={coupon.status === 'void' ? 'disabled' : coupon.status === 'used' ? 'paid' : 'running'} /></td>
      <td className="col-actions">
        <RowMenu disabled={submitting || blocked} items={menuItems} />
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

/** 建立券抽屜：版型比照 ProductsPage 的 CreateProductDrawer，常駐表單會把清單擠到摺線以下。 */
function CreateCouponDrawer({
  promotions,
  selectorReady,
  onClose,
  onRunOperation,
  recovery,
}: {
  promotions: Promotion[];
  selectorReady: boolean;
  onClose: () => void;
  onRunOperation: RunCouponOperation;
  recovery: CouponOperationEntry | null;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [promotionId, setPromotionId] = useState('');
  const [partnerCode, setPartnerCode] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perCustomerOnce, setPerCustomerOnce] = useState(true);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const codeRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = recovery !== null;
  useEffect(() => {
    if (recovery?.operation.kind !== 'create') return;
    const request = recovery.operation.draft;
    setCode(request.code); setPromotionId(request.promotionId); setPartnerCode(request.partnerCode);
    setMaxRedemptions(request.maxRedemptions); setPerCustomerOnce(request.perCustomerOnce); setStartsAt(request.startsAt); setEndsAt(request.endsAt);
  }, [recovery]);
  useEffect(() => { if (locked) cancelRef.current?.focus(); }, [locked]);

  const submit = async () => {
    if (!selectorReady && !recovery) {
      setError(new Error(t('selectPromotion')));
      return;
    }
    const trimmed = code.trim();
    const max = maxRedemptions.trim() === '' ? undefined : Number(maxRedemptions);
    if (!trimmed || !promotionId || (max !== undefined && (!Number.isInteger(max) || max <= 0))) {
      setError(new Error(t('invalidCoupon')));
      return;
    }
    // 後端也會擋，但先在這裡說清楚：送出去再被退回，使用者得自己猜是哪一個欄位錯。
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setError(new Error(t('invalidPeriod')));
      return;
    }
    setSubmitting(true);
    setError(null);
    const request = {
        code: trimmed,
        promotionId,
        partnerCode: partnerCode.trim() || undefined,
        maxRedemptions: max,
        perCustomerLimit: perCustomerOnce ? 1 : null,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      };
    const draft = { code, promotionId, partnerCode, maxRedemptions, perCustomerOnce, startsAt, endsAt };
    const result = await onRunOperation({ area: 'coupon', scope: 'coupon:create', kind: 'create', request, draft, idempotencyKey: crypto.randomUUID() });
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
        aria-label={t('createCoupon')}
        onOpenAutoFocus={(event) => { event.preventDefault(); (locked ? cancelRef.current : codeRef.current)?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('createCoupon')}</DialogTitle>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('createCoupon')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <fieldset className="drawer-form-body" disabled={locked || submitting || !selectorReady} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <div className="form-field">
              <label htmlFor="create-coupon-code">
                <span className="field-label-text">{t('couponCode')}</span>
              </label>
              <input
                id="create-coupon-code"
                ref={codeRef}
                aria-label={t('couponCode')}
                className="mono"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SUMMER20"
              />
            </div>

            <div className="form-field">
              <label htmlFor="create-coupon-promotion">
                <span className="field-label-text">{t('promotionName')}</span>
              </label>
              <select
                id="create-coupon-promotion"
                aria-label={t('promotionName')}
                value={promotionId}
                onChange={(e) => setPromotionId(e.target.value)}
              >
                <option value="">{t('selectPromotion')}</option>
                {promotions.map((promotion) => (
                  <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="create-coupon-partner">
                <span className="field-label-text">{t('partnerCode')}</span>
              </label>
              <input
                id="create-coupon-partner"
                aria-label={t('partnerCode')}
                value={partnerCode}
                onChange={(e) => setPartnerCode(e.target.value)}
                placeholder={t('partnerCodeHint')}
              />
            </div>

            <div className="form-field">
              <label htmlFor="create-coupon-max-redemptions">
                <span className="field-label-text">{t('maxRedemptions')}</span>
              </label>
              <input
                id="create-coupon-max-redemptions"
                aria-label={t('maxRedemptions')}
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                inputMode="numeric"
              />
            </div>

            {/* 檔期是一組：開始與結束各佔一列，兩邊的日期與時間欄寬才對得齊。 */}
            <DateTimeField
              id="create-coupon-starts-at"
              label={t('startsAt')}
              value={startsAt}
              hint={t('couponStartsAtHint')}
              onChange={setStartsAt}
            />

            <DateTimeField
              id="create-coupon-ends-at"
              label={t('endsAt')}
              value={endsAt}
              onChange={setEndsAt}
            />

            <label className="checkbox">
              <input type="checkbox" checked={perCustomerOnce} onChange={(e) => setPerCustomerOnce(e.target.checked)} />
              {t('perCustomerOnce')}
            </label>
          </fieldset>

          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={locked || submitting || !selectorReady}>
              {submitting ? '建立中…' : t('create')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 批次發券抽屜：由工具列自己的按鈕開啟，與建立券互不影響。 */
function IssueCouponsDrawer({
  promotions,
  selectorReady,
  onClose,
  onRunOperation,
  recovery,
}: {
  promotions: Promotion[];
  selectorReady: boolean;
  onClose: () => void;
  onRunOperation: RunCouponOperation;
  recovery: CouponOperationEntry | null;
}) {
  const { t } = useI18n();
  const [promotionId, setPromotionId] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('30');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<IssueResult | null>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const promotionRef = useRef<HTMLSelectElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = recovery !== null;
  useEffect(() => {
    if (recovery?.operation.kind !== 'issue') return;
    const request = recovery.operation.draft;
    setPromotionId(request.promotionId); setCodePrefix(request.codePrefix); setExpiresInDays(request.expiresInDays);
  }, [recovery]);
  useEffect(() => { if (locked) cancelRef.current?.focus(); }, [locked]);

  const submit = async () => {
    if (!selectorReady && !recovery) {
      setError(new Error(t('selectPromotion')));
      return;
    }
    const days = expiresInDays.trim() === '' ? undefined : Number(expiresInDays);
    if (!promotionId || (days !== undefined && (!Number.isInteger(days) || days <= 0))) {
      setError(new Error(t('invalidIssue')));
      return;
    }
    setSubmitting(true);
    setError(null);
    const request = {
        promotionId,
        codePrefix: codePrefix.trim() || undefined,
        expiresInDays: days,
      };
    const draft = { promotionId, codePrefix, expiresInDays };
    const operationResult = await onRunOperation({ area: 'coupon', scope: 'coupon:issue', kind: 'issue', request, draft, preview: { promotionName: promotions.find((promotion) => promotion.id === promotionId)?.name ?? promotionId }, idempotencyKey: crypto.randomUUID() });
    if (operationResult.state === 'success') setResult(operationResult.result as IssueResult);
    if (operationResult.state === 'rejected') setError(operationResult.error);
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
        aria-label={t('issueCoupons')}
        onOpenAutoFocus={(event) => { event.preventDefault(); (locked ? cancelRef.current : promotionRef.current)?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('issueCoupons')}</DialogTitle>
            <p className="product-drawer-sku">{t('issueCouponsHint')}</p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('issueCoupons')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          {result ? <p role="status">{t('issueResult')}: {result.issued}（{t('skipped')}: {result.skipped}）</p> : null}

          <fieldset className="drawer-form-body" disabled={locked || submitting || !selectorReady} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <div className="form-field">
              <label htmlFor="issue-coupon-promotion">
                <span className="field-label-text">{t('promotionName')}</span>
              </label>
              <select
                id="issue-coupon-promotion"
                ref={promotionRef}
                aria-label={t('issuePromotion')}
                value={promotionId}
                onChange={(e) => setPromotionId(e.target.value)}
              >
                <option value="">{t('selectPromotion')}</option>
                {promotions.map((promotion) => (
                  <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
                ))}
              </select>
            </div>

            <div className="form-grid-2">
              <div className="form-field">
                <label htmlFor="issue-coupon-prefix">
                  <span className="field-label-text">{t('codePrefix')}</span>
                </label>
                <input
                  id="issue-coupon-prefix"
                  aria-label={t('codePrefix')}
                  value={codePrefix}
                  onChange={(e) => setCodePrefix(e.target.value.toUpperCase())}
                  placeholder="VIP"
                />
              </div>

              <div className="form-field">
                <label htmlFor="issue-coupon-expires">
                  <span className="field-label-text">{t('expiresInDays')}</span>
                </label>
                <input
                  id="issue-coupon-expires"
                  aria-label={t('expiresInDays')}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>
          </fieldset>

          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={locked || submitting || !selectorReady}>
              {submitting ? '發放中…' : t('issue')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
