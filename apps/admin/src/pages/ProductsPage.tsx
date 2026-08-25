import { useEffect, useState } from 'react';
import { api, type Product, type Stock } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

/**
 * 售價只接受十進位的非負整數字串。驗 `Number()` 的結果會放行 ''、'   '、
 * '1e3' 與 '0x10'——清空欄位就等於把商品改成 0 元，而且沒有任何警示。
 * 建立與編輯共用這一個述詞，不各留一份。
 */
export function parsePriceCents(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

export function ProductsPage() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [stocks, setStocks] = useState<Record<string, Stock>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listProducts({ q, status: status || undefined, limit: 50 })
      .then(async (result) => {
        if (cancelled) return;
        setProducts(result.items);
        const stockEntries = await Promise.all(
          result.items.map((p) => api.getInventory(p.id).then((s) => [p.id, s] as const).catch(() => null)),
        );
        if (cancelled) return;
        const next: Record<string, Stock> = {};
        for (const entry of stockEntries) {
          if (entry) next[entry[0]] = entry[1];
        }
        setStocks(next);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [q, status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      <div className="toolbar">
        <input placeholder={t('searchProducts')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('allStatuses')}</option><option value="draft">{t('draft')}</option><option value="active">{t('active')}</option><option value="archived">{t('archived')}</option>
        </select>
      </div>

      <CreateProductForm onCreated={reload} />

      {loading && products.length === 0 ? (
        <Loading />
      ) : (
        <div className="table-wrap" aria-busy={loading}><table className="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>{t('name')}</th><th>{t('price')}</th><th>{t('status')}</th><th>{t('inventory')}</th><th>{t('adjustInventory')}</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <ProductRow key={product.id} product={product} stock={stocks[product.id]} onChanged={reload} />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

/**
 * 上下架寫成具名的轉換而不是一個自由下拉：command 那一側沒有狀態機，
 * 任何轉換都收，所以「哪些走得通」這件事只存在於這裡。
 */
const NEXT_STATUS: Record<Product['status'], { to: Product['status']; label: 'publish' | 'unpublish' | 'archive' | 'republish' }[]> = {
  draft: [{ to: 'active', label: 'publish' }],
  // 下架回草稿與封存是兩件事：前者是「先收回去改」，後者是「這個商品退役了」。
  active: [{ to: 'draft', label: 'unpublish' }, { to: 'archived', label: 'archive' }],
  archived: [{ to: 'active', label: 'republish' }],
};

function ProductRow({
  product,
  stock,
  onChanged,
}: {
  product: Product;
  stock: Stock | undefined;
  onChanged: () => void;
}) {
  const { t, formatMoney } = useI18n();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
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

  const handleAdjust = async () => {
    const deltaNum = Number(delta);
    if (!Number.isInteger(deltaNum) || deltaNum === 0 || !reason.trim()) {
      setError(new Error(t('invalidInventory')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.adjustInventory({ productId: product.id, delta: deltaNum, reason: reason.trim() });
      setDelta('');
      setReason('');
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <tr>
      <td>{product.sku}</td>
      <td>{product.name}</td>
      <td className="mono">{formatMoney(product.priceCents, product.currency)}</td>
      <td><StatusBadge value={product.status} /></td>
      <td className="mono">{stock ? `${stock.available} / ${stock.reserved} / ${stock.onHand}` : '—'}</td>
      <td>
        <div className="inline-form">
          <input placeholder={t('adjustment')} value={delta} onChange={(e) => setDelta(e.target.value)} />
          <input placeholder={t('reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="button" type="button" disabled={submitting} onClick={handleAdjust}>
            {t('adjust')}
          </button>
        </div>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        <div className="inline-form">
          <button className="button" type="button" disabled={submitting} onClick={() => setEditing((value) => !value)}>{t('edit')}</button>
          {NEXT_STATUS[product.status].map((transition) => (
            <button key={transition.to} className="button" type="button" disabled={submitting} onClick={() => void changeStatus(transition.to)}>
              {t(transition.label)}
            </button>
          ))}
        </div>
        {statusError ? <ErrorBanner error={statusError} onDismiss={() => setStatusError(null)} /> : null}
      </td>
    </tr>
    {editing ? (
      <tr>
        <td colSpan={6}>
          <EditProductForm product={product} onClose={() => setEditing(false)} onSaved={onChanged} />
        </td>
      </tr>
    ) : null}
    </>
  );
}

function EditProductForm({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? '');
  const [priceCents, setPriceCents] = useState(String(product.priceCents));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
    <form className="form-panel" aria-label={`${t('editProduct')} ${product.sku}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <div className="inline-form">
        <label>{t('productName')}<input aria-label={t('productName')} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t('description')}<textarea aria-label={t('description')} rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label>{t('priceCents')}<input aria-label={t('priceCents')} value={priceCents} onChange={(e) => setPriceCents(e.target.value)} /></label>
      </div>
      <p className="muted">{t('priceSnapshotHint')}</p>
      <div className="inline-form">
        <button className="button button--primary" disabled={submitting}>{t('saveChanges')}</button>
        <button className="button" type="button" onClick={onClose}>{t('cancel')}</button>
      </div>
    </form>
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
    <fieldset id="create-product" className="form-panel">
      <legend>{t('createProduct')}</legend>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <div className="inline-form">
        <input placeholder="SKU" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input placeholder={t('name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder={t('priceCents')} value={priceCents} onChange={(e) => setPriceCents(e.target.value)} />
        <input placeholder={t('currency')} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value as Product['status'])}>
          <option value="draft">{t('draft')}</option><option value="active">{t('active')}</option><option value="archived">{t('archived')}</option>
        </select>
        <button className="button button--primary" type="button" disabled={submitting} onClick={handleSubmit}>
          {t('create')}
        </button>
      </div>
    </fieldset>
  );
}
