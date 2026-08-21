import { useState } from 'react';
import { getToken, setToken } from './api';
import { navigate, useRoute, type Route } from './router';
import { ProductsPage } from './pages/ProductsPage';
import { OrdersPage } from './pages/OrdersPage';
import { ErpPage } from './pages/ErpPage';
import { SystemPage } from './pages/SystemPage';

const NAV_ITEMS: { route: Route; label: string }[] = [
  { route: 'products', label: '商品' },
  { route: 'orders', label: '訂單' },
  { route: 'erp', label: 'ERP 投遞' },
  { route: 'system', label: '系統狀態' },
];

export function App() {
  const route = useRoute();
  // token 換了就重掛載頁面，讓資料立刻用新的憑證重抓一次
  const [tokenVersion, setTokenVersion] = useState(0);

  return (
    <div className="app">
      <header className="app-header">
        <h1>StoreWeave 管理後台</h1>
        <TokenBar onTokenChange={() => setTokenVersion((v) => v + 1)} />
      </header>
      <nav className="app-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.route}
            type="button"
            className={route === item.route ? 'app-nav__item app-nav__item--active' : 'app-nav__item'}
            onClick={() => navigate(item.route)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <main className="app-main" key={tokenVersion}>
        {route === 'products' && <ProductsPage />}
        {route === 'orders' && <OrdersPage />}
        {route === 'erp' && <ErpPage />}
        {route === 'system' && <SystemPage />}
      </main>
    </div>
  );
}

/** 管理 API token 的輸入 / 儲存 / 清除 */
function TokenBar({ onTokenChange }: { onTokenChange: () => void }) {
  const [draft, setDraft] = useState(getToken());
  const [saved, setSaved] = useState(getToken());

  const handleSave = () => {
    setToken(draft);
    setSaved(draft);
    onTokenChange();
  };

  const handleClear = () => {
    setToken('');
    setDraft('');
    setSaved('');
    onTokenChange();
  };

  return (
    <div className="token-bar">
      <input
        type="password"
        placeholder="輸入 API token"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="button" onClick={handleSave}>
        儲存
      </button>
      <button type="button" onClick={handleClear}>
        清除
      </button>
      <span className="token-bar__status">{saved ? '已設定 token' : '尚未設定 token'}</span>
    </div>
  );
}
