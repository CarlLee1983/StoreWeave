import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Product, type Stock } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { CopyButton } from '../components/CopyButton';
import { Icon, type IconName } from '../components/Icon';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog';
import { inventoryQueryKeys, productCommandKey, productQueryKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry as ProductOperationEntry, useAdminOperationEntries as useProductOperationEntries, useAdminOperations as useProductOperations } from '../admin-operations';

/**
 * 售價只接受十進位的非負整數字串。驗 `Number()` 的結果會放行 ''、'   '、
 * '1e3' 與 '0x10'——清空欄位就等於把商品改成 0 元，而且沒有任何警示。
 * 建立與編輯共用這一個述詞，不各留一份。
 */
export function parsePriceCents(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

type RunProductOperationResult =
  | { state: 'blocked' | 'stale' | 'success' | 'unknown' }
  | { state: 'rejected'; error: unknown };
type CreateProductRequest = { sku: string; name: string; description?: string; priceCents: number; currency: string; status: Product['status'] };
type ProductPatch = { name?: string; description?: string | null; priceCents?: number; status?: Product['status'] };
type AdjustInventoryRequest = { productId: string; delta: number; reason?: string; reference?: string };
type ProductOperation = AdminOperation & (
  | { kind: 'create'; request: CreateProductRequest; draft: CreateProductRequest }
  | { kind: 'edit'; productId: string; request: ProductPatch; draft: { sku: string; currency: string; status: Product['status']; name: string; description: string; priceCents: string } }
  | { kind: 'status'; productId: string; request: { status: Product['status'] } }
  | { kind: 'stock'; productId: string; request: AdjustInventoryRequest; draft: { mode: 'add' | 'deduct' | 'set'; quantity: string; reason: string; customReason: string } }
);
type RunProductOperation = (operation: ProductOperation, retryEntry?: ProductOperationEntry<ProductOperation>) => Promise<RunProductOperationResult>;
type Recovery<K extends ProductOperation['kind']> = ProductOperationEntry<Extract<ProductOperation, { kind: K }>>;
function recoveryFor<K extends ProductOperation['kind']>(entry: ProductOperationEntry<ProductOperation> | null, kind: K): Recovery<K> | null {
  return entry?.operation.kind === kind ? entry as Recovery<K> : null;
}
function operationLabel(operation: ProductOperation) {
  return operation.kind === 'create' ? operation.kind : `${operation.kind} · ${operation.productId}`;
}
function operationScope(operation: ProductOperation) {
  return operation.scope;
}
function recoveryProduct(operation: Exclude<ProductOperation, { kind: 'create' | 'status' }>): Product {
  if (operation.kind === 'edit') {
    return { id: operation.productId, sku: operation.draft.sku, name: operation.draft.name, description: operation.draft.description || null, priceCents: Number(operation.draft.priceCents) || 0, currency: operation.draft.currency, status: operation.draft.status, createdAt: '', updatedAt: '' };
  }
  return { id: operation.productId, sku: operation.productId, name: operation.productId, description: null, priceCents: 0, currency: 'TWD', status: 'draft', createdAt: '', updatedAt: '' };
}
function isProductOperationEntry(entry: ProductOperationEntry): entry is ProductOperationEntry<ProductOperation> {
  const { operation } = entry;
  return operation.area === 'product' && operation.scope.startsWith('product:')
    && 'kind' in operation && typeof operation.kind === 'string'
    && ['create', 'edit', 'status', 'stock'].includes(operation.kind);
}

export function ProductsPage() {
  const { t, tCount, formatMoney } = useI18n();
  const queryClient = useQueryClient();
  const productOperations = useProductOperations();
  const operationEntries = useProductOperationEntries().filter(isProductOperationEntry);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [adjustingStockTarget, setAdjustingStockTarget] = useState<{ product: Product; stock?: Stock; returnFocus?: HTMLElement | null } | null>(null);
  const [creating, setCreating] = useState(false);

  // 當關鍵字或狀態篩選改變時，重設至第一頁
  const handleQueryChange = (val: string) => {
    setQ(val);
    setPage(1);
  };

  const handleStatusChange = (val: string) => {
    setStatus(val);
    setPage(1);
  };

  const productInput = useMemo(() => ({ q: q.trim() || undefined, status: status || undefined, limit: pageSize, offset: (page - 1) * pageSize }), [q, status, page, pageSize]);
  const productsQuery = useQuery({ queryKey: productQueryKeys.list(productInput), queryFn: ({ signal }) => api.listProducts(productInput, signal) });
  const hasProductData = productsQuery.data !== undefined;
  const products = productsQuery.data?.items ?? [];
  const total = productsQuery.data?.total ?? 0;
  const inventoryInput = useMemo(() => ({ productIds: products.map((product) => product.id), limit: products.length }), [products]);
  const inventoryQuery = useQuery({
    queryKey: inventoryQueryKeys.list(inventoryInput),
    queryFn: ({ signal }) => api.listInventory(inventoryInput, signal),
    enabled: inventoryInput.productIds.length > 0,
  });
  const stocks = useMemo(() => {
    if (!inventoryQuery.isSuccess) return {} as Record<string, Stock>;
    const byId = new Map(inventoryQuery.data.items.map((stock) => [stock.productId, stock]));
    return Object.fromEntries(products.map((product) => [product.id, byId.get(product.id) ?? { productId: product.id, onHand: 0, reserved: 0, available: 0, updatedAt: '' }])) as Record<string, Stock>;
  }, [inventoryQuery.data, inventoryQuery.isSuccess, products]);

  const commandMutation = useMutation<Product | Stock, unknown, ProductOperation>({
    mutationKey: productCommandKey,
    mutationFn: (operation: ProductOperation) => {
      switch (operation.kind) {
        case 'create': return api.createProduct(operation.request, operation.idempotencyKey);
        case 'edit': case 'status': return api.patchProduct(operation.productId, operation.request, operation.idempotencyKey);
        case 'stock': return api.adjustInventory(operation.request, operation.idempotencyKey);
      }
    },
  });
  const runOperation: RunProductOperation = async (operation, retryEntry) => {
    return executeAdminOperation(productOperations, operation, (live) => commandMutation.mutateAsync(live),
      (_result, live) => { void queryClient.invalidateQueries({ queryKey: live.kind === 'stock' ? inventoryQueryKeys.lists : productQueryKeys.lists }); return undefined; }, retryEntry);
  };
  const recover = (entry: ProductOperationEntry<ProductOperation>) => {
    if (entry.phase !== 'unknown') return;
    const operation = entry.operation;
    if (operation.kind === 'create') { setCreating(true); return; }
    if (operation.kind === 'status') return;
    const product = products.find((item) => item.id === operation.productId) ?? recoveryProduct(operation);
    if (operation.kind === 'edit') setEditingProduct(product);
    if (operation.kind === 'stock') setAdjustingStockTarget({ product, stock: stocks[product.id] });
  };

  // 頁首那顆「+ 建立商品」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開抽屜，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => {
      event.preventDefault();
      setCreating(true);
    };
    window.addEventListener('admin:action:create-product', openCreate);
    return () => window.removeEventListener('admin:action:create-product', openCreate);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 計算統計摘要
  const activeCount = products.filter((p) => p.status === 'active').length;
  const draftCount = products.filter((p) => p.status === 'draft').length;
  const archivedCount = products.filter((p) => p.status === 'archived').length;

  return (
    <section className="products-view">
      {productsQuery.isError ? <ErrorBanner error={productsQuery.error} onRetry={() => void productsQuery.refetch()} /> : null}
      {inventoryQuery.isError ? <ErrorBanner error={inventoryQuery.error} onRetry={() => void inventoryQuery.refetch()} /> : null}
      {operationEntries.map((entry) => (
        <div className="error-banner" role="status" key={`${entry.operation.kind}:${entry.operation.idempotencyKey}`}>
          <strong>{entry.phase === 'pending' ? t('productOperationInFlight') : t('productOperationOutcomeUnknown')}</strong>
          <span>{operationLabel(entry.operation)}：{entry.phase === 'pending' ? t('productOperationInFlight') : entry.error instanceof Error ? entry.error.message : t('productOperationOutcomeUnknown')}</span>
          {entry.phase === 'unknown' && entry.operation.kind !== 'status' ? <button type="button" className="button button--quiet" onClick={() => recover(entry)}>{t('inspectOriginalOperation')}</button> : null}
          {entry.phase === 'unknown' ? <button type="button" className="button button--quiet" onClick={() => void runOperation(entry.operation, entry)}>{t('retryOriginalOperation')}</button> : null}
        </div>
      ))}

      {/* 頂部商品狀態總覽卡片 */}
      {hasProductData ? <div className="summary-cards summary-cards--products">
        <div className="summary-card">
          <span className="summary-card__label">{t('filteredProductTotal')}</span>
          <span className="summary-card__value">{total}</span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">{t('pageActiveProducts')}</span>
          <span className="summary-card__value" style={{ color: 'var(--status-success-text)' }}>
            {activeCount}
          </span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">{t('pageDraftProducts')}</span>
          <span className="summary-card__value" style={{ color: 'var(--status-warning-text)' }}>
            {draftCount}
          </span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">{t('pageArchivedProducts')}</span>
          <span className="summary-card__value" style={{ color: 'var(--text-muted)' }}>
            {archivedCount}
          </span>
        </div>
      </div> : null}

      {/* 工具列：搜尋、狀態過濾、每頁筆數 */}
      <div className="toolbar products-toolbar">
        <div className="toolbar__search-group">
          <Icon name="search" />
          <input
            placeholder={t('searchProducts')}
            value={q}
            onChange={(e) => handleQueryChange(e.target.value)}
          />
        </div>
        <select
          className="products-status-filter"
          value={status}
          onChange={(e) => handleStatusChange(e.target.value)}
        >
          <option value="">{t('allStatuses')}</option>
          <option value="draft">{t('draft')}</option>
          <option value="active">{t('active')}</option>
          <option value="archived">{t('archived')}</option>
        </select>
        <div className="toolbar__page-size">
          <label>
            <span>{t('itemsPerPage')}</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              <option value="10">10 {t('items')}</option>
              <option value="20">20 {t('items')}</option>
              <option value="50">50 {t('items')}</option>
            </select>
          </label>
        </div>
      </div>

      {/* 商品表格 */}
      {productsQuery.isLoading ? (
        <Loading />
      ) : hasProductData ? (
        <div className="table-wrap" aria-busy={productsQuery.isFetching || inventoryQuery.isFetching}>
          <table className="data-table data-table--fixed products-table">
            <thead>
              <tr>
                <th style={{ width: '13%' }}>SKU</th>
                <th style={{ width: '31%' }}>{t('name')}</th>
                <th style={{ width: '11%' }} className="col-numeric">{t('price')}</th>
                <th style={{ width: '9%' }}>{t('status')}</th>
                <th style={{ width: '21%' }}>{t('inventory')}</th>
                <th style={{ width: '14%' }} className="col-actions">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                    {t('noMatchingProducts')}
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    stock={stocks[product.id]}
                    onEdit={() => setEditingProduct(product)}
                    onAdjustStock={(returnFocus) => {
                      if (inventoryQuery.isSuccess) setAdjustingStockTarget({ product, stock: stocks[product.id], returnFocus });
                    }}
                    canAdjustStock={inventoryQuery.isSuccess}
                    onRunOperation={runOperation}
                  />
                ))
              )}
            </tbody>
          </table>

          {/* 分頁控制列 */}
          <div className="pagination-bar">
            <div className="pagination-bar__info">
              <span>
                {t('paginationInfo', { start: (page - 1) * pageSize + 1, end: Math.min(page * pageSize, total), total })}
              </span>
            </div>
            <div className="pagination-bar__controls">
              <button
                type="button"
                className="button button--quiet pagination-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <Icon name="arrow-left" /> {t('previousPage')}
              </button>
              <span className="pagination-page-badge">
                {t('paginationPage', { page, total: totalPages })}
              </span>
              <button
                type="button"
                className="button button--quiet pagination-btn"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t('nextPage')} <Icon name="arrow-right" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 建立商品抽屜 */}
      {creating ? (
        <CreateProductDrawer
          onClose={() => setCreating(false)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => operationScope(entry.operation) === 'product:create') ?? null}
        />
      ) : null}

      {/* 側邊抽屜式商品編輯器 */}
      {editingProduct ? (
        <EditProductDrawer
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => operationScope(entry.operation) === `product:edit:${editingProduct.id}`) ?? null}
        />
      ) : null}

      {/* 具象化庫存調整對話框 */}
      {adjustingStockTarget ? (
        <AdjustStockModal
          product={adjustingStockTarget.product}
          stock={adjustingStockTarget.stock}
          returnFocus={adjustingStockTarget.returnFocus}
          onClose={() => setAdjustingStockTarget(null)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => operationScope(entry.operation) === `product:stock:${adjustingStockTarget.product.id}`) ?? null}
        />
      ) : null}
    </section>
  );
}

/**
 * 上下架寫成具名的轉換而不是一個自由下拉：command 那一側沒有狀態機，
 * 任何轉換都收，所以「哪些走得通」這件事只存在於這裡。
 */
const NEXT_STATUS: Record<
  Product['status'],
  { to: Product['status']; label: 'publish' | 'unpublish' | 'archive' | 'republish'; icon: IconName; danger?: boolean }[]
> = {
  draft: [{ to: 'active', label: 'publish', icon: 'upload' }],
  active: [
    { to: 'draft', label: 'unpublish', icon: 'eye-off' },
    { to: 'archived', label: 'archive', icon: 'archive', danger: true },
  ],
  archived: [{ to: 'active', label: 'republish', icon: 'upload' }],
};

function ProductRow({
  product,
  stock,
  onEdit,
  onAdjustStock,
  canAdjustStock,
  onRunOperation,
}: {
  product: Product;
  stock: Stock | undefined;
  onEdit: () => void;
  onAdjustStock: (returnFocus?: HTMLElement | null) => void;
  canAdjustStock: boolean;
  onRunOperation: RunProductOperation;
}) {
  const { t, tCount, formatMoney } = useI18n();
  const [statusError, setStatusError] = useState<unknown>(null);

  const changeStatus = async (to: Product['status']) => {
    setStatusError(null);
    const result = await onRunOperation({ area: 'product', scope: `product:status:${product.id}`, kind: 'status', productId: product.id, request: { status: to }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'rejected') setStatusError(result.error);
  };

  const menuItems: RowMenuItem[] = [
    { key: 'adjust-stock', label: t('adjustInventory'), icon: 'box', disabled: !canAdjustStock, onSelect: onAdjustStock },
    ...NEXT_STATUS[product.status].map((transition) => ({
      key: transition.to,
      label: t(transition.label),
      icon: transition.icon,
      danger: transition.danger,
      onSelect: () => void changeStatus(transition.to),
    })),
  ];

  return (
    <tr className="product-row">
      <td>
        <div className="product-sku-cell">
          <span className="mono">{product.sku}</span>
          <CopyButton text={product.sku} label="SKU" />
        </div>
      </td>
      <td>
        <div className="product-name-cell">
          <strong>{product.name}</strong>
          {product.description ? (
            <p className="product-desc-snippet" title={product.description}>
              {product.description}
            </p>
          ) : null}
        </div>
      </td>
      <td className="mono product-price-cell col-numeric">
        {formatMoney(product.priceCents, product.currency)}
      </td>
      <td>
        <StatusBadge value={product.status} />
      </td>
      <td>
        {stock ? (
          <button
            type="button"
            className="stock-breakdown-btn"
            onClick={(event) => onAdjustStock(event.currentTarget)}
            title={t('stockAdjustHint')}
          >
            <div className="stock-breakdown">
              <span className={`stock-avail ${stock.available > 0 ? 'stock-avail--ok' : 'stock-avail--out'}`}>
                {t('stockAvailable')} {stock.available}
              </span>
              {/* 保留為 0 時不佔位：一整欄的「保留 0」只是噪音。 */}
              <span className="stock-meta" title={`${t('stockOnHand')} ${stock.onHand} · ${t('stockReserved')} ${stock.reserved}`}>
                {t('stockOnHand')} {stock.onHand}{stock.reserved > 0 ? ` · ${t('stockReserved')} ${stock.reserved}` : ''}
              </span>
            </div>
            <span className="stock-btn-hint" aria-hidden="true"><Icon name="pencil" /></span>
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td>
        <div className="product-actions-cell">
          <div className="product-actions-row">
            <button
              className="button button--quiet edit-btn"
              type="button"
              disabled={false}
              onClick={onEdit}
            >
              <Icon name="pencil" /> {t('edit')}
            </button>
            <RowMenu items={menuItems} />
          </div>
          {statusError ? <ErrorBanner error={statusError} onDismiss={() => setStatusError(null)} /> : null}
        </div>
      </td>
    </tr>
  );
}

/** 具象化庫存調整對話框 */
function AdjustStockModal({
  product,
  stock,
  returnFocus,
  onClose,
  onRunOperation,
  recovery,
}: {
  product: Product;
  stock?: Stock;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onRunOperation: RunProductOperation;
  recovery: ProductOperationEntry<ProductOperation> | null;
}) {
  const { t, tCount } = useI18n();
  const recovered = recoveryFor(recovery, 'stock');
  const [mode, setMode] = useState<'add' | 'deduct' | 'set'>(recovered?.operation.draft.mode ?? 'add');
  const [qtyInput, setQtyInput] = useState(recovered?.operation.draft.quantity ?? '');
  const [selectedReason, setSelectedReason] = useState(recovered?.operation.draft.reason ?? '廠商進貨入庫');
  const [customReason, setCustomReason] = useState(recovered?.operation.draft.customReason ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const qtyRef = useRef<HTMLInputElement>(null);

  const hasStockSnapshot = stock !== undefined;
  const currentOnHand = stock?.onHand;
  const currentReserved = stock?.reserved;
  const currentAvailable = stock?.available;

  // 預設常用原因清單與後端 Enum 對應
  const PRESET_REASONS: { icon: IconName; reasonCode: string; text: string; label: string }[] = [
    { icon: 'box', reasonCode: 'restock', text: '廠商進貨入庫', label: t('restockReason') },
    { icon: 'clipboard', reasonCode: 'correction', text: '定期盤點更正', label: t('correctionReasonPreset') },
    { icon: 'alert', reasonCode: 'damage', text: '運送破損報廢', label: t('damageReason') },
    { icon: 'gift', reasonCode: 'manual', text: '樣品展示領用', label: t('manualReason') },
    { icon: 'rotate', reasonCode: 'return', text: '客服退貨入庫', label: t('returnReasonPreset') },
  ];

  // 計算實際 delta
  let calculatedDelta: number | null = null;
  const parsed = Number(qtyInput.trim());

  if (hasStockSnapshot && qtyInput.trim() !== '' && Number.isInteger(parsed) && parsed >= 0) {
    if (mode === 'add') calculatedDelta = parsed;
    else if (mode === 'deduct') calculatedDelta = -parsed;
    else if (mode === 'set') calculatedDelta = parsed - currentOnHand!;
  }

  // 預測調整後的現有庫存與可售庫存。沒有庫存快照就沒有預測值可言，
  // 用 undefined 表示「算不出來」，由畫面決定不顯示，而不是印出 NaN。
  const hasSnapshot = currentOnHand !== undefined && currentReserved !== undefined;
  const predictedOnHand = calculatedDelta !== null && hasSnapshot ? currentOnHand + calculatedDelta : currentOnHand;
  const predictedAvailable = calculatedDelta !== null && hasSnapshot && predictedOnHand !== undefined
    ? predictedOnHand - currentReserved
    : currentAvailable;
  const isNegativeStock = predictedOnHand !== undefined && predictedOnHand < 0;

  const handleApplyPreset = (text: string) => {
    setSelectedReason(text);
  };

  const submit = async () => {
    let operation: ProductOperation;
    if (recovered) {
      operation = recovered.operation;
    } else {
      if (calculatedDelta === null || calculatedDelta === 0) {
        setError(new Error(t('invalidStockQuantity')));
        return;
      }
      if (isNegativeStock) {
        setError(new Error(t('invalidNegativeStock')));
        return;
      }
      const matchedPreset = PRESET_REASONS.find((p) => p.text === selectedReason);
      const reasonCode = matchedPreset ? matchedPreset.reasonCode : mode === 'add' ? 'restock' : mode === 'deduct' ? 'damage' : 'correction';
      const finalReference = customReason.trim() ? `${selectedReason} - ${customReason.trim()}` : selectedReason;
      operation = {
        area: 'product', scope: `product:stock:${product.id}`, kind: 'stock', productId: product.id, idempotencyKey: crypto.randomUUID(),
        request: { productId: product.id, delta: calculatedDelta, reason: reasonCode, reference: finalReference },
        draft: { mode, quantity: qtyInput, reason: selectedReason, customReason },
      };
    }
    setError(null);
    setSubmitting(true);
    const result = await onRunOperation(operation, recovered ?? undefined);
    if (result.state === 'success') onClose();
    else if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-stock-dialog"
        aria-label={`${t('adjustInventory')} - ${product.name}`}
        onOpenAutoFocus={(event) => { if (!recovered) { event.preventDefault(); qtyRef.current?.focus(); } }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="stock-modal-header">
          <div>
            <DialogTitle><Icon name="box" /> {t('adjustInventory')}</DialogTitle>
            <p className="stock-modal-subtitle">
              {product.name} <span className="mono">({product.sku})</span>
            </p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')}>
            <Icon name="close" />
          </DialogClose>
        </header>

        <div className="stock-modal-body">
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          {/* 當前庫存水位 */}
          {hasStockSnapshot ? <div className="stock-status-bar">
            <div className="stock-stat-box">
              <span className="stock-stat-label">{t('stockOnHand')}</span>
              <span className="stock-stat-val mono">{currentOnHand}</span>
            </div>
            <div className="stock-stat-box">
              <span className="stock-stat-label">{t('stockReserved')}</span>
              <span className="stock-stat-val mono text-muted">{currentReserved}</span>
            </div>
            <div className="stock-stat-box stock-stat-box--avail">
              <span className="stock-stat-label">{t('stockAvailable')}</span>
              <span className="stock-stat-val mono">{currentAvailable}</span>
            </div>
          </div> : <p className="text-muted">{t('stockSnapshotUnavailable')}</p>}

          {/* 調整模式切換 Tab */}
          <div className="stock-mode-tabs">
            <button
              type="button"
              className={`stock-mode-tab ${mode === 'add' ? 'stock-mode-tab--active stock-mode-tab--add' : ''}`}
              disabled={!!recovered} onClick={() => {
                setMode('add');
                if (selectedReason === '運送破損報廢') setSelectedReason('廠商進貨入庫');
              }}
            >
              <Icon name="plus-circle" /> {t('stockAddMode')}
            </button>
            <button
              type="button"
              className={`stock-mode-tab ${mode === 'deduct' ? 'stock-mode-tab--active stock-mode-tab--deduct' : ''}`}
              disabled={!!recovered} onClick={() => {
                setMode('deduct');
                if (selectedReason === '廠商進貨入庫') setSelectedReason('運送破損報廢');
              }}
            >
              <Icon name="minus-circle" /> {t('stockDeductMode')}
            </button>
            <button
              type="button"
              className={`stock-mode-tab ${mode === 'set' ? 'stock-mode-tab--active stock-mode-tab--set' : ''}`}
              disabled={!!recovered} onClick={() => {
                setMode('set');
                setSelectedReason('定期盤點更正');
              }}
            >
              <Icon name="target" /> {t('stockSetMode')}
            </button>
          </div>

          {/* 數量輸入 */}
          <div className="form-field stock-input-field">
            <label htmlFor="stock-qty-input">
              <span className="field-label-text">
                {mode === 'add' && <><Icon name="plus-circle" /> {t('stockAddQuantity')}</>}
                {mode === 'deduct' && <><Icon name="minus-circle" /> {t('stockDeductQuantity')}</>}
                {mode === 'set' && <><Icon name="target" /> {t('stockSetQuantity')}</>}
              </span>
            </label>
            <input
              id="stock-qty-input"
              ref={qtyRef}
              type="number"
              min="0"
              step="1"
              autoFocus
              className="stock-number-input mono"
              placeholder={t('stockQuantityExample', { count: mode === 'set' && currentOnHand !== undefined ? currentOnHand : 10 })}
              value={qtyInput}
              disabled={!!recovered}
              onChange={(e) => setQtyInput(e.target.value)}
            />
          </div>

          {/* 實時試算預覽 */}
          {/* 沒有庫存快照就算不出預估值。舊寫法用 String(undefined) 會直接把
              「undefined 件」顯示給操作者，型別檢查在這次遷移時抓到。 */}
          {calculatedDelta !== null && calculatedDelta !== 0 && hasSnapshot && predictedOnHand !== undefined && predictedAvailable !== undefined ? (
            <div className={`stock-forecast-box ${isNegativeStock ? 'stock-forecast-box--danger' : ''}`}>
              <div className="forecast-delta-line">
                <span>{t('stockChange')}</span>
                <strong className={`delta-tag ${calculatedDelta > 0 ? 'delta-tag--pos' : 'delta-tag--neg'}`}>
                  {tCount('stockQuantity', calculatedDelta, { count: calculatedDelta > 0 ? `+${calculatedDelta}` : calculatedDelta })}
                </strong>
              </div>
              <div className="forecast-result-line">
                <span>{t('stockForecastOnHand')}</span>
                <strong>
                  {tCount('stockQuantity', currentOnHand)} → <span className="mono">{tCount('stockQuantity', predictedOnHand)}</span>
                </strong>
                <span className="forecast-avail-sub">{t('stockForecastAvailable', { count: predictedAvailable })}</span>
              </div>
              {isNegativeStock ? (
                <p className="danger-text"><Icon name="alert" /> {t('stockCannotBeNegative')}</p>
              ) : null}
            </div>
          ) : null}

          {/* 常用原因選擇 */}
          <div className="form-field">
            <label>
              <span className="field-label-text"><Icon name="clipboard" /> {t('stockReason')}</span>
            </label>
            <div className="preset-reasons-grid">
              {PRESET_REASONS.map((p) => (
                <button
                  key={p.reasonCode}
                  type="button"
                  className={`preset-reason-pill ${selectedReason === p.text ? 'preset-reason-pill--active' : ''}`}
                  disabled={!!recovered} onClick={() => handleApplyPreset(p.text)}
                >
                  <Icon name={p.icon} /> {p.label}
                </button>
              ))}
            </div>
            <input
              className="custom-reason-input"
              placeholder={t('stockReferencePlaceholder')}
              value={customReason}
              disabled={!!recovered}
              onChange={(e) => setCustomReason(e.target.value)}
            />
          </div>
        </div>

        <footer className="stock-modal-footer">
          <button className="button" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="button button--primary stock-confirm-btn"
            type="button"
            disabled={submitting || (!recovered && (calculatedDelta === null || calculatedDelta === 0 || isNegativeStock))}
            onClick={submit}
          >
            {submitting ? t('adjustingStock') : t('confirmAdjustStock')}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** 側邊專業滑出編輯抽屜 */
function EditProductDrawer({
  product,
  onClose,
  onRunOperation,
  recovery,
}: {
  product: Product;
  onClose: () => void;
  onRunOperation: RunProductOperation;
  recovery: ProductOperationEntry<ProductOperation> | null;
}) {
  const { t, tCount, formatMoney } = useI18n();
  const recovered = recoveryFor(recovery, 'edit');
  const [name, setName] = useState(recovered?.operation.draft.name ?? product.name);
  const [description, setDescription] = useState(recovered?.operation.draft.description ?? product.description ?? '');
  const [priceCents, setPriceCents] = useState(recovered?.operation.draft.priceCents ?? String(product.priceCents));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 計算價格即時預覽
  const parsedPrice = parsePriceCents(priceCents);
  const previewFormatted = parsedPrice !== null ? formatMoney(parsedPrice, product.currency) : t('invalidAmount');

  const submit = async () => {
    let operation: ProductOperation;
    if (recovered) {
      operation = recovered.operation;
    } else {
      const price = parsePriceCents(priceCents);
      if (!name.trim() || price === null) {
        setError(new Error(t('invalidProductEdit')));
        return;
      }
      // 只送真的改過的欄位：全欄位 PATCH 會把「沒碰」與「清空」混為一談，
      // 而空的 patch 在 command 那一側是必然被拒的 validation error。
      const patch: { name?: string; description?: string | null; priceCents?: number } = {};
      if (name.trim() !== product.name) patch.name = name.trim();
      // 清空描述送 null，不送 ''：兩者都會被讀成「沒有描述」，但留兩種寫法
      // 等於讓資料庫同時存在兩個真值，而建立那一側走的是 `?? null`。
      if (description.trim() !== (product.description ?? '')) patch.description = description.trim() || null;
      if (price !== product.priceCents) patch.priceCents = price;
      if (Object.keys(patch).length === 0) {
        setError(new Error(t('noFieldsChanged')));
        return;
      }
      operation = { area: 'product', scope: `product:edit:${product.id}`, kind: 'edit', productId: product.id, request: patch, idempotencyKey: crypto.randomUUID(), draft: { sku: product.sku, currency: product.currency, status: product.status, name, description, priceCents } };
    }
    setError(null);
    setSubmitting(true);
    const result = await onRunOperation(operation, recovered ?? undefined);
    if (result.state === 'success') onClose();
    else if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-product-sheet"
        onOpenAutoFocus={(event) => { if (!recovered) { event.preventDefault(); nameRef.current?.focus(); } }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('editProduct')}</DialogTitle>
            <p className="product-drawer-sku">
              SKU: <span className="mono">{product.sku}</span> · ID: <span className="mono">{product.id.slice(0, 8)}...</span>
            </p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={`${t('editProduct')} ${product.sku}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <div className="drawer-form-body">
            <div className="form-field">
              <label htmlFor="edit-product-name">
                <span className="field-label-text">{t('productName')} <b className="required-star">*</b></span>
              </label>
              <input
                id="edit-product-name"
                ref={nameRef}
                aria-label={t('productName')}
                value={name}
                disabled={!!recovered}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('productNamePlaceholder')}
              />
            </div>

            <div className="form-field">
              <label htmlFor="edit-product-price">
                <span className="field-label-text">{t('priceCents')} <b className="required-star">*</b></span>
                <span className="price-preview-badge">{t('pricePreview', { value: previewFormatted })}</span>
              </label>
              <input
                id="edit-product-price"
                aria-label={t('priceCents')}
                value={priceCents}
                disabled={!!recovered}
                onChange={(e) => setPriceCents(e.target.value)}
                placeholder={t('priceExample')}
              />
              <p className="field-hint">{t('priceSnapshotHint')}</p>
            </div>

            <div className="form-field">
              <label htmlFor="edit-product-desc">
                <span className="field-label-text">{t('description')}</span>
                <span className="char-counter">{description.length} / 4000 {t('characters')}</span>
              </label>
              <textarea
                id="edit-product-desc"
                aria-label={t('description')}
                rows={8}
                maxLength={4000}
                value={description}
                disabled={!!recovered}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('productDescriptionPlaceholder')}
              />
            </div>
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {submitting ? t('saving') : t('saveChanges')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 建立商品抽屜：與編輯共用同一套版型，避免建立表單常駐佔掉清單上方一整塊。 */
function CreateProductDrawer({ onClose, onRunOperation, recovery }: { onClose: () => void; onRunOperation: RunProductOperation; recovery: ProductOperationEntry<ProductOperation> | null }) {
  const { t, tCount, formatMoney } = useI18n();
  const recovered = recoveryFor(recovery, 'create');
  const [sku, setSku] = useState(recovered?.operation.draft.sku ?? '');
  const [name, setName] = useState(recovered?.operation.draft.name ?? '');
  const [priceCents, setPriceCents] = useState(recovered ? String(recovered.operation.draft.priceCents) : '');
  const [currency, setCurrency] = useState(recovered?.operation.draft.currency ?? 'TWD');
  const [status, setStatus] = useState<Product['status']>(recovered?.operation.draft.status ?? 'draft');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const skuRef = useRef<HTMLInputElement>(null);

  const parsedPrice = parsePriceCents(priceCents);
  // 還沒輸入就先喊「無效金額」只是嚇人，留白到真的打錯為止。
  const pricePreview = priceCents.trim() === ''
    ? null
    : parsedPrice !== null ? formatMoney(parsedPrice, currency) : t('invalidAmount');

  const submit = async () => {
    const price = parsePriceCents(priceCents);
    if (!sku.trim() || !name.trim() || price === null) {
      setError(new Error(t('invalidProduct')));
      return;
    }
    setError(null);
    const request = { sku: sku.trim(), name: name.trim(), priceCents: price, currency, status };
    setSubmitting(true);
    const operation: ProductOperation = recovered?.operation ?? { area: 'product', scope: 'product:create', kind: 'create', request, draft: request, idempotencyKey: crypto.randomUUID() };
    const result = await onRunOperation(operation, recovered ?? undefined);
    if (result.state === 'success') onClose();
    else if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-product-sheet"
        onOpenAutoFocus={(event) => { if (!recovered) { event.preventDefault(); skuRef.current?.focus(); } }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('createProduct')}</DialogTitle>
            <p className="product-drawer-sku">{t('productCreateHint')}</p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('createProduct')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <div className="drawer-form-body">
            <div className="form-field">
              <label htmlFor="create-product-sku">
                <span className="field-label-text">SKU <b className="required-star">*</b></span>
              </label>
              <input
                id="create-product-sku"
                ref={skuRef}
                aria-label="SKU"
                className="mono"
                autoFocus
                value={sku}
                disabled={!!recovered}
                onChange={(e) => setSku(e.target.value)}
                placeholder={t('skuExample')}
              />
              <p className="field-hint">{t('skuImmutableHint')}</p>
            </div>

            <div className="form-field">
              <label htmlFor="create-product-name">
                <span className="field-label-text">{t('name')} <b className="required-star">*</b></span>
              </label>
              <input
                id="create-product-name"
                aria-label={t('name')}
                value={name}
                disabled={!!recovered}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('productNamePlaceholder')}
              />
            </div>

            <div className="form-field">
              <label htmlFor="create-product-price">
                <span className="field-label-text">{t('priceCents')} <b className="required-star">*</b></span>
                {pricePreview ? <span className="price-preview-badge">{t('pricePreview', { value: pricePreview })}</span> : null}
              </label>
              <input
                id="create-product-price"
                aria-label={t('priceCents')}
                value={priceCents}
                disabled={!!recovered}
                onChange={(e) => setPriceCents(e.target.value)}
                placeholder={t('priceExample')}
              />
            </div>

            <div className="form-grid-2">
              <div className="form-field">
                <label htmlFor="create-product-currency">
                  <span className="field-label-text">{t('currency')}</span>
                </label>
                <input
                  id="create-product-currency"
                  aria-label={t('currency')}
                  className="mono"
                value={currency}
                disabled={!!recovered}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="create-product-status">
                  <span className="field-label-text">{t('status')}</span>
                </label>
                <select
                  id="create-product-status"
                  aria-label={t('status')}
                  value={status}
                  disabled={!!recovered}
                  onChange={(e) => setStatus(e.target.value as Product['status'])}
                >
                  <option value="draft">{t('draft')}</option>
                  <option value="active">{t('active')}</option>
                  <option value="archived">{t('archived')}</option>
                </select>
              </div>
            </div>
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {submitting ? t('creating') : t('create')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
