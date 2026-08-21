import { useEffect, useState } from 'react';
import { api, formatMoney, type Product, type Stock } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

export function ProductsPage() {
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
        <input placeholder="搜尋商品名稱或 SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部狀態</option>
          <option value="draft">草稿</option>
          <option value="active">上架中</option>
          <option value="archived">已下架</option>
        </select>
      </div>

      <CreateProductForm onCreated={reload} />

      {loading ? (
        <Loading />
      ) : (
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>名稱</th>
              <th>價格</th>
              <th>狀態</th>
              <th>庫存（可用 / 保留 / 現有）</th>
              <th>調整庫存</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <ProductRow key={product.id} product={product} stock={stocks[product.id]} onAdjusted={reload} />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function ProductRow({
  product,
  stock,
  onAdjusted,
}: {
  product: Product;
  stock: Stock | undefined;
  onAdjusted: () => void;
}) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleAdjust = async () => {
    const deltaNum = Number(delta);
    if (!Number.isInteger(deltaNum) || deltaNum === 0 || !reason.trim()) {
      setError(new Error('請輸入非零整數的調整量與原因'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.adjustInventory({ productId: product.id, delta: deltaNum, reason: reason.trim() });
      setDelta('');
      setReason('');
      onAdjusted();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <tr>
      <td>{product.sku}</td>
      <td>{product.name}</td>
      <td className="mono">{formatMoney(product.priceCents, product.currency)}</td>
      <td><StatusBadge value={product.status} /></td>
      <td className="mono">{stock ? `${stock.available} / ${stock.reserved} / ${stock.onHand}` : '—'}</td>
      <td>
        <div className="inline-form">
          <input placeholder="調整量" value={delta} onChange={(e) => setDelta(e.target.value)} />
          <input placeholder="原因" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="button" type="button" disabled={submitting} onClick={handleAdjust}>
            調整
          </button>
        </div>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

function CreateProductForm({ onCreated }: { onCreated: () => void }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [priceCents, setPriceCents] = useState('');
  const [currency, setCurrency] = useState('TWD');
  const [status, setStatus] = useState<Product['status']>('draft');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleSubmit = async () => {
    const price = Number(priceCents);
    if (!sku.trim() || !name.trim() || !Number.isInteger(price) || price < 0) {
      setError(new Error('請填寫 SKU、名稱，以及非負整數的價格（cents）'));
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
      <legend>建立商品</legend>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <div className="inline-form">
        <input placeholder="SKU" value={sku} onChange={(e) => setSku(e.target.value)} />
        <input placeholder="名稱" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="價格（cents）" value={priceCents} onChange={(e) => setPriceCents(e.target.value)} />
        <input placeholder="幣別" value={currency} onChange={(e) => setCurrency(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value as Product['status'])}>
          <option value="draft">草稿</option>
          <option value="active">上架中</option>
          <option value="archived">已下架</option>
        </select>
        <button className="button button--primary" type="button" disabled={submitting} onClick={handleSubmit}>
          建立
        </button>
      </div>
    </fieldset>
  );
}
