import { useEffect, useState } from 'react';
import { api, type Product, type Stock } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { CopyButton } from '../components/CopyButton';
import { Icon, type IconName } from '../components/Icon';

/**
 * 售價只接受十進位的非負整數字串。驗 `Number()` 的結果會放行 ''、'   '、
 * '1e3' 與 '0x10'——清空欄位就等於把商品改成 0 元，而且沒有任何警示。
 * 建立與編輯共用這一個述詞，不各留一份。
 */
export function parsePriceCents(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

export function ProductsPage() {
  const { t, formatMoney } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [products, setProducts] = useState<Product[]>([]);
  const [stocks, setStocks] = useState<Record<string, Stock>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [adjustingStockTarget, setAdjustingStockTarget] = useState<{ product: Product; stock?: Stock } | null>(null);

  // 當關鍵字或狀態篩選改變時，重設至第一頁
  const handleQueryChange = (val: string) => {
    setQ(val);
    setPage(1);
  };

  const handleStatusChange = (val: string) => {
    setStatus(val);
    setPage(1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const offset = (page - 1) * pageSize;

    api
      .listProducts({ q: q.trim() || undefined, status: status || undefined, limit: pageSize, offset })
      .then(async (result) => {
        if (cancelled) return;
        setProducts(result.items);
        setTotal(result.total);

        // 一次查回本頁商品的庫存；沒有庫存記錄的商品視為 0，不逐列打 API。
        const productIds = result.items.map((p) => p.id);
        const stockPage = productIds.length > 0
          ? await api.listInventory({ productIds, limit: productIds.length }).catch(() => ({ items: [] as Stock[], total: 0 }))
          : { items: [] as Stock[], total: 0 };
        if (cancelled) return;
        const byProductId = new Map(stockPage.items.map((s) => [s.productId, s]));
        const next: Record<string, Stock> = {};
        for (const p of result.items) {
          next[p.id] = byProductId.get(p.id)
            ?? { productId: p.id, onHand: 0, reserved: 0, available: 0, updatedAt: new Date().toISOString() };
        }
        setStocks(next);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [q, status, page, pageSize, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 計算統計摘要
  const activeCount = products.filter((p) => p.status === 'active').length;
  const draftCount = products.filter((p) => p.status === 'draft').length;
  const archivedCount = products.filter((p) => p.status === 'archived').length;

  return (
    <section className="products-view">
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      {/* 頂部商品狀態總覽卡片 */}
      <div className="summary-cards summary-cards--products">
        <div className="summary-card">
          <span className="summary-card__label">總商品數</span>
          <span className="summary-card__value">{total}</span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">上架中 (Active)</span>
          <span className="summary-card__value" style={{ color: 'var(--status-success-text)' }}>
            {activeCount}
          </span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">草稿 (Draft)</span>
          <span className="summary-card__value" style={{ color: 'var(--status-warning-text)' }}>
            {draftCount}
          </span>
        </div>
        <div className="summary-card">
          <span className="summary-card__label">已封存 (Archived)</span>
          <span className="summary-card__value" style={{ color: 'var(--text-muted)' }}>
            {archivedCount}
          </span>
        </div>
      </div>

      {/* 工具列：搜尋、狀態過濾、每頁筆數 */}
      <div className="toolbar products-toolbar">
        <div className="toolbar__search-group">
          <Icon name="search" />
          <input
            className="products-search-input"
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
            <span>每頁顯示</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              <option value="10">10 筆</option>
              <option value="20">20 筆</option>
              <option value="50">50 筆</option>
            </select>
          </label>
        </div>
      </div>

      <CreateProductForm onCreated={reload} />

      {/* 商品表格 */}
      {loading && products.length === 0 ? (
        <Loading />
      ) : (
        <div className="table-wrap" aria-busy={loading}>
          <table className="data-table products-table">
            <thead>
              <tr>
                <th style={{ width: '16%' }}>SKU</th>
                <th style={{ width: '24%' }}>{t('name')}</th>
                <th style={{ width: '12%' }}>{t('price')}</th>
                <th style={{ width: '10%' }}>{t('status')}</th>
                <th style={{ width: '18%' }}>{t('inventory')}</th>
                <th style={{ width: '20%' }}>操作與管理</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                    沒有找到符合條件的商品。
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    stock={stocks[product.id]}
                    onEdit={() => setEditingProduct(product)}
                    onAdjustStock={() => setAdjustingStockTarget({ product, stock: stocks[product.id] })}
                    onChanged={reload}
                  />
                ))
              )}
            </tbody>
          </table>

          {/* 分頁控制列 */}
          <div className="pagination-bar">
            <div className="pagination-bar__info">
              <span>
                顯示第 {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} 筆，共 {total} 件商品
              </span>
            </div>
            <div className="pagination-bar__controls">
              <button
                type="button"
                className="button button--quiet pagination-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <Icon name="arrow-left" /> 上一頁
              </button>
              <span className="pagination-page-badge">
                第 {page} / {totalPages} 頁
              </span>
              <button
                type="button"
                className="button button--quiet pagination-btn"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一頁 <Icon name="arrow-right" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 側邊抽屜式商品編輯器 */}
      {editingProduct ? (
        <EditProductDrawer
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            reload();
            setEditingProduct(null);
          }}
        />
      ) : null}

      {/* 具象化庫存調整對話框 */}
      {adjustingStockTarget ? (
        <AdjustStockModal
          product={adjustingStockTarget.product}
          stock={adjustingStockTarget.stock}
          onClose={() => setAdjustingStockTarget(null)}
          onSaved={() => {
            reload();
            setAdjustingStockTarget(null);
          }}
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
  { to: Product['status']; label: 'publish' | 'unpublish' | 'archive' | 'republish' }[]
> = {
  draft: [{ to: 'active', label: 'publish' }],
  active: [
    { to: 'draft', label: 'unpublish' },
    { to: 'archived', label: 'archive' },
  ],
  archived: [{ to: 'active', label: 'republish' }],
};

function ProductRow({
  product,
  stock,
  onEdit,
  onAdjustStock,
  onChanged,
}: {
  product: Product;
  stock: Stock | undefined;
  onEdit: () => void;
  onAdjustStock: () => void;
  onChanged: () => void;
}) {
  const { t, formatMoney } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [statusError, setStatusError] = useState<unknown>(null);

  const changeStatus = async (to: Product['status']) => {
    setSubmitting(true);
    setStatusError(null);
    try {
      await api.patchProduct(product.id, { status: to });
      onChanged();
    } catch (err) {
      setStatusError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <tr>
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
      <td className="mono product-price-cell">
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
            onClick={onAdjustStock}
            title="點擊進行庫存調整"
          >
            <div className="stock-breakdown">
              <span className={`stock-avail ${stock.available > 0 ? 'stock-avail--ok' : 'stock-avail--out'}`}>
                可售 {stock.available} 件
              </span>
              <span className="stock-meta">
                現貨 {stock.onHand} · 保留 {stock.reserved}
              </span>
            </div>
            <span className="stock-btn-hint">調整 <Icon name="pencil" /></span>
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td>
        <div className="product-actions-cell">
          <div className="inline-form product-lifecycle-form">
            <button
              className="button button--primary edit-btn"
              type="button"
              disabled={submitting}
              onClick={onEdit}
            >
              <Icon name="receipt" /> {t('edit')}
            </button>
            <button
              className="button stock-adjust-btn"
              type="button"
              disabled={submitting}
              onClick={onAdjustStock}
            >
              <Icon name="box" /> 調整庫存
            </button>
            {NEXT_STATUS[product.status].map((transition) => (
              <button
                key={transition.to}
                className="button status-transition-btn"
                type="button"
                disabled={submitting}
                onClick={() => void changeStatus(transition.to)}
              >
                {t(transition.label)}
              </button>
            ))}
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
  onClose,
  onSaved,
}: {
  product: Product;
  stock?: Stock;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'add' | 'deduct' | 'set'>('add');
  const [qtyInput, setQtyInput] = useState('');
  const [selectedReason, setSelectedReason] = useState('廠商進貨入庫');
  const [customReason, setCustomReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const currentOnHand = stock?.onHand ?? 0;
  const currentReserved = stock?.reserved ?? 0;
  const currentAvailable = stock?.available ?? 0;

  // 預設常用原因清單與後端 Enum 對應
  const PRESET_REASONS: { icon: IconName; reasonCode: string; text: string }[] = [
    { icon: 'box', reasonCode: 'restock', text: '廠商進貨入庫' },
    { icon: 'clipboard', reasonCode: 'correction', text: '定期盤點更正' },
    { icon: 'alert', reasonCode: 'damage', text: '運送破損報廢' },
    { icon: 'gift', reasonCode: 'manual', text: '樣品展示領用' },
    { icon: 'rotate', reasonCode: 'return', text: '客服退貨入庫' },
  ];

  // 計算實際 delta
  let calculatedDelta: number | null = null;
  const parsed = Number(qtyInput.trim());

  if (qtyInput.trim() !== '' && Number.isInteger(parsed) && parsed >= 0) {
    if (mode === 'add') calculatedDelta = parsed;
    else if (mode === 'deduct') calculatedDelta = -parsed;
    else if (mode === 'set') calculatedDelta = parsed - currentOnHand;
  }

  // 預測調整後的現有庫存與可售庫存
  const predictedOnHand = calculatedDelta !== null ? currentOnHand + calculatedDelta : currentOnHand;
  const predictedAvailable = calculatedDelta !== null ? predictedOnHand - currentReserved : currentAvailable;
  const isNegativeStock = predictedOnHand < 0;

  const handleApplyPreset = (text: string) => {
    setSelectedReason(text);
  };

  const submit = async () => {
    if (calculatedDelta === null || calculatedDelta === 0) {
      setError(new Error('請輸入大於 0 的數量，且變更量不能為 0'));
      return;
    }
    if (isNegativeStock) {
      setError(new Error(`庫存扣除後將小於 0（目前現貨 ${currentOnHand} 件），無法出庫！`));
      return;
    }

    const matchedPreset = PRESET_REASONS.find((p) => p.text === selectedReason);
    const reasonCode = matchedPreset
      ? matchedPreset.reasonCode
      : mode === 'add'
        ? 'restock'
        : mode === 'deduct'
          ? 'damage'
          : 'correction';

    const finalReference = customReason.trim()
      ? `${selectedReason} - ${customReason.trim()}`
      : selectedReason;

    setSubmitting(true);
    setError(null);
    try {
      await api.adjustInventory({
        productId: product.id,
        delta: calculatedDelta,
        reason: reasonCode,
        reference: finalReference,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="payload-overlay stock-modal-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="stock-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={`調整庫存 - ${product.name}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="stock-modal-header">
          <div>
            <h3><Icon name="box" /> 庫存調整與盤點</h3>
            <p className="stock-modal-subtitle">
              {product.name} <span className="mono">({product.sku})</span>
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')}>
            <Icon name="close" />
          </button>
        </header>

        <div className="stock-modal-body">
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          {/* 當前庫存水位 */}
          <div className="stock-status-bar">
            <div className="stock-stat-box">
              <span className="stock-stat-label">現有庫存 (On Hand)</span>
              <span className="stock-stat-val mono">{currentOnHand}</span>
            </div>
            <div className="stock-stat-box">
              <span className="stock-stat-label">訂單保留 (Reserved)</span>
              <span className="stock-stat-val mono text-muted">{currentReserved}</span>
            </div>
            <div className="stock-stat-box stock-stat-box--avail">
              <span className="stock-stat-label">可銷售 (Available)</span>
              <span className="stock-stat-val mono">{currentAvailable}</span>
            </div>
          </div>

          {/* 調整模式切換 Tab */}
          <div className="stock-mode-tabs">
            <button
              type="button"
              className={`stock-mode-tab ${mode === 'add' ? 'stock-mode-tab--active stock-mode-tab--add' : ''}`}
              onClick={() => {
                setMode('add');
                if (selectedReason === '運送破損報廢') setSelectedReason('廠商進貨入庫');
              }}
            >
              <Icon name="plus-circle" /> 入庫 / 進貨 (+N)
            </button>
            <button
              type="button"
              className={`stock-mode-tab ${mode === 'deduct' ? 'stock-mode-tab--active stock-mode-tab--deduct' : ''}`}
              onClick={() => {
                setMode('deduct');
                if (selectedReason === '廠商進貨入庫') setSelectedReason('運送破損報廢');
              }}
            >
              <Icon name="minus-circle" /> 出庫 / 報損 (-N)
            </button>
            <button
              type="button"
              className={`stock-mode-tab ${mode === 'set' ? 'stock-mode-tab--active stock-mode-tab--set' : ''}`}
              onClick={() => {
                setMode('set');
                setSelectedReason('定期盤點更正');
              }}
            >
              <Icon name="target" /> 盤點直接設總數 (=N)
            </button>
          </div>

          {/* 數量輸入 */}
          <div className="form-field stock-input-field">
            <label htmlFor="stock-qty-input">
              <span className="field-label-text">
                {mode === 'add' && <><Icon name="plus-circle" /> 請輸入進貨 / 增加件數：</>}
                {mode === 'deduct' && <><Icon name="minus-circle" /> 請輸入扣除 / 報廢件數：</>}
                {mode === 'set' && <><Icon name="target" /> 請輸入倉庫現場盤點實點總數：</>}
              </span>
            </label>
            <input
              id="stock-qty-input"
              type="number"
              min="0"
              step="1"
              autoFocus
              className="stock-number-input mono"
              placeholder={mode === 'set' ? `例如：${currentOnHand}` : '例如：10'}
              value={qtyInput}
              onChange={(e) => setQtyInput(e.target.value)}
            />
          </div>

          {/* 實時試算預覽 */}
          {calculatedDelta !== null && calculatedDelta !== 0 ? (
            <div className={`stock-forecast-box ${isNegativeStock ? 'stock-forecast-box--danger' : ''}`}>
              <div className="forecast-delta-line">
                <span>變動幅度：</span>
                <strong className={`delta-tag ${calculatedDelta > 0 ? 'delta-tag--pos' : 'delta-tag--neg'}`}>
                  {calculatedDelta > 0 ? `+${calculatedDelta}` : calculatedDelta} 件
                </strong>
              </div>
              <div className="forecast-result-line">
                <span>預估調整後現貨：</span>
                <strong>
                  {currentOnHand} 件 → <span className="mono">{predictedOnHand} 件</span>
                </strong>
                <span className="forecast-avail-sub">（可售變為 {predictedAvailable} 件）</span>
              </div>
              {isNegativeStock ? (
                <p className="danger-text"><Icon name="alert" /> 警告：現貨庫存不能為負數，請檢查出庫數量！</p>
              ) : null}
            </div>
          ) : null}

          {/* 常用原因選擇 */}
          <div className="form-field">
            <label>
              <span className="field-label-text"><Icon name="clipboard" /> 調整原因：</span>
            </label>
            <div className="preset-reasons-grid">
              {PRESET_REASONS.map((p) => (
                <button
                  key={p.reasonCode}
                  type="button"
                  className={`preset-reason-pill ${selectedReason === p.text ? 'preset-reason-pill--active' : ''}`}
                  onClick={() => handleApplyPreset(p.text)}
                >
                  <Icon name={p.icon} /> {p.text}
                </button>
              ))}
            </div>
            <input
              className="custom-reason-input"
              placeholder="補充說明或採購單號 (選填)"
              value={customReason}
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
            disabled={submitting || calculatedDelta === null || calculatedDelta === 0 || isNegativeStock}
            onClick={submit}
          >
            {submitting ? '調整中…' : '確認調整庫存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 側邊專業滑出編輯抽屜 */
function EditProductDrawer({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, formatMoney } = useI18n();
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? '');
  const [priceCents, setPriceCents] = useState(String(product.priceCents));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 計算價格即時預覽
  const parsedPrice = parsePriceCents(priceCents);
  const previewFormatted = parsedPrice !== null ? formatMoney(parsedPrice, product.currency) : '無效金額';

  const submit = async () => {
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
    setSubmitting(true);
    setError(null);
    try {
      await api.patchProduct(product.id, patch);
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="payload-drawer product-edit-drawer"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="product-drawer-header">
          <div>
            <h2>{t('editProduct')}</h2>
            <p className="product-drawer-sku">
              SKU: <span className="mono">{product.sku}</span> · ID: <span className="mono">{product.id.slice(0, 8)}...</span>
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </button>
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
                aria-label={t('productName')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="輸入商品名稱"
              />
            </div>

            <div className="form-field">
              <label htmlFor="edit-product-price">
                <span className="field-label-text">{t('priceCents')} <b className="required-star">*</b></span>
                <span className="price-preview-badge">預覽：{previewFormatted}</span>
              </label>
              <input
                id="edit-product-price"
                aria-label={t('priceCents')}
                value={priceCents}
                onChange={(e) => setPriceCents(e.target.value)}
                placeholder="例如：128000"
              />
              <p className="field-hint">{t('priceSnapshotHint')}</p>
            </div>

            <div className="form-field">
              <label htmlFor="edit-product-desc">
                <span className="field-label-text">{t('description')}</span>
                <span className="char-counter">{description.length} / 4000 字</span>
              </label>
              <textarea
                id="edit-product-desc"
                aria-label={t('description')}
                rows={8}
                maxLength={4000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="輸入商品的天然材質、工藝特點、尺寸規格與保養指南..."
              />
            </div>
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {submitting ? '儲存中…' : t('saveChanges')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function CreateProductForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [priceCents, setPriceCents] = useState('');
  const [currency, setCurrency] = useState('TWD');
  const [status, setStatus] = useState<Product['status']>('draft');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleSubmit = async () => {
    const price = parsePriceCents(priceCents);
    if (!sku.trim() || !name.trim() || price === null) {
      setError(new Error(t('invalidProduct')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.createProduct({ sku: sku.trim(), name: name.trim(), priceCents: price, currency, status });
      setSku('');
      setName('');
      setPriceCents('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <fieldset id="create-product" className="form-panel create-product-panel">
      <legend>+ {t('createProduct')}</legend>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <div className="inline-form create-product-inputs">
        <input placeholder="SKU (例如: WD-NEW-01)" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input placeholder={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder={t('priceCents')} value={priceCents} onChange={(e) => setPriceCents(e.target.value)} />
        <input placeholder={t('currency')} value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: '80px' }} />
        <select value={status} onChange={(e) => setStatus(e.target.value as Product['status'])}>
          <option value="draft">{t('draft')}</option>
          <option value="active">{t('active')}</option>
          <option value="archived">{t('archived')}</option>
        </select>
        <button className="button button--primary" type="button" disabled={submitting} onClick={handleSubmit}>
          {t('create')}
        </button>
      </div>
    </fieldset>
  );
}
