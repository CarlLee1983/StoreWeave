import { useEffect, useState, type ReactNode } from 'react';
import { getToken, setDisplayLocale, setToken } from './api';
import { navigate, useRoute, type Route } from './router';
import { ProductsPage } from './pages/ProductsPage';
import { OrdersPage } from './pages/OrdersPage';
import { ErpPage } from './pages/ErpPage';
import { SystemPage } from './pages/SystemPage';

type IconName = 'box' | 'receipt' | 'activity' | 'database' | 'search' | 'sun' | 'moon' | 'key' | 'chevron';

const NAV_ITEMS: { route: Route; label: string; icon: IconName; section: 'commerce' | 'integrations'; badge?: string }[] = [
  { route: 'orders', label: '訂單', icon: 'receipt', section: 'commerce', badge: 'LIVE' },
  { route: 'products', label: '商品', icon: 'box', section: 'commerce' },
  { route: 'erp', label: 'ERP 佇列', icon: 'database', section: 'integrations', badge: 'DLQ' },
  { route: 'system', label: '系統健康度', icon: 'activity', section: 'integrations' },
];

const PAGE_COPY: Record<Route, { title: string; subtitle: string; action?: string }> = {
  orders: { title: '訂單管理', subtitle: '即時交易流與 ERP 投遞管線' },
  products: { title: '商品管理', subtitle: '管理商品目錄、售價與可用庫存', action: '建立商品' },
  erp: { title: 'ERP 投遞', subtitle: '追蹤訂單事件、重試與 Dead Letter Queue' },
  system: { title: '系統狀態', subtitle: '服務相依性、擴充套件與銷售匯總' },
};

export function App() {
  const route = useRoute();
  const [tokenVersion, setTokenVersion] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('storeweave.admin.theme') as 'dark' | 'light') || 'dark');
  const [locale, setLocale] = useState('zh-TW');
  const [commandOpen, setCommandOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('storeweave.admin.theme', theme);
  }, [theme]);

  useEffect(() => { document.documentElement.lang = locale; setDisplayLocale(locale); }, [locale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if (event.key === 'Escape') { setCommandOpen(false); setTokenOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const currentPage = PAGE_COPY[route];
  const go = (nextRoute: Route) => { navigate(nextRoute); setCommandOpen(false); };

  return <div className="app-shell">
    <aside className="sidebar" aria-label="主要導覽">
      <div className="brand"><span className="brand__mark" aria-hidden="true"><Icon name="box" /></span><span>StoreWeave</span></div>
      <nav className="sidebar__nav">
        {(['commerce', 'integrations'] as const).map((section) => <div className="nav-group" key={section}>
          <p className="nav-group__label">{section === 'commerce' ? 'Commerce' : 'Integrations'}</p>
          {NAV_ITEMS.filter((item) => item.section === section).map((item) => <button key={item.route} type="button" aria-label={item.label} className={`nav-link ${route === item.route ? 'nav-link--active' : ''}`} onClick={() => go(item.route)}>
            <Icon name={item.icon} /><span>{item.label}</span>{item.badge ? <span className={`nav-badge ${item.badge === 'DLQ' ? 'nav-badge--error' : ''}`}>{item.badge}</span> : null}
          </button>)}
        </div>)}
      </nav>
      <div className="sidebar__footer"><span className="connection-indicator" />v0.1.0 <span>Online</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <button type="button" className="command-trigger" onClick={() => setCommandOpen(true)} aria-label="開啟命令選單"><Icon name="search" /><span>搜尋頁面或操作</span><kbd>⌘ K</kbd></button>
        <div className="topbar__utilities">
          <label className="locale-select" title="語言"><span className="sr-only">語言</span><select value={locale} onChange={(event) => setLocale(event.target.value)}><option value="zh-TW">繁中</option><option value="en-US">EN</option><option value="ja-JP">日本語</option></select></label>
          <button type="button" className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切換明暗主題" title="切換明暗主題"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button type="button" className={`token-trigger ${getToken() ? 'token-trigger--set' : ''}`} onClick={() => setTokenOpen(!tokenOpen)} aria-expanded={tokenOpen}><Icon name="key" />API Token</button>
          {tokenOpen ? <TokenPanel onTokenChange={() => setTokenVersion((value) => value + 1)} onClose={() => setTokenOpen(false)} /> : null}
        </div>
      </header>
      <main className="content" key={`${tokenVersion}-${locale}`}>
        <div className="page-heading"><div><h1>{currentPage.title}</h1><p>{currentPage.subtitle}</p></div>{currentPage.action ? <button type="button" className="button button--primary" onClick={() => document.getElementById(route === 'products' ? 'create-product' : 'order-actions')?.scrollIntoView({ behavior: 'smooth' })}>+ {currentPage.action}</button> : null}</div>
        {route === 'products' && <ProductsPage />}{route === 'orders' && <OrdersPage />}{route === 'erp' && <ErpPage />}{route === 'system' && <SystemPage />}
      </main>
    </div>
    {commandOpen ? <CommandPalette onNavigate={go} onClose={() => setCommandOpen(false)} /> : null}
  </div>;
}

function TokenPanel({ onTokenChange, onClose }: { onTokenChange: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState(getToken());
  const save = () => { setToken(draft); onTokenChange(); onClose(); };
  const clear = () => { setToken(''); setDraft(''); onTokenChange(); };
  return <div className="token-panel" role="dialog" aria-label="API Token 設定"><p>API Token</p><span>憑證只儲存在此瀏覽器。</span><input autoFocus type="password" placeholder="輸入 API token" value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button type="button" className="button button--quiet" onClick={clear}>清除</button><button type="button" className="button button--primary" onClick={save}>儲存</button></div></div>;
}

function CommandPalette({ onNavigate, onClose }: { onNavigate: (route: Route) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const choose = (index: number) => matches[index] && onNavigate(matches[index].route);
  return <div className="command-overlay" role="presentation" onMouseDown={onClose}><div className="command-palette" role="dialog" aria-modal="true" aria-label="命令選單" onMouseDown={(event) => event.stopPropagation()}><div className="command-palette__search"><Icon name="search" /><input autoFocus placeholder="搜尋頁面…" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, matches.length - 1)); } if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); } if (event.key === 'Enter') choose(active); }} /></div><p>前往</p>{matches.map((item, index) => <button key={item.route} type="button" className={index === active ? 'command-palette__option--active' : ''} onClick={() => onNavigate(item.route)}><Icon name={item.icon} /><span>{item.label}</span><Icon name="chevron" /></button>)}<footer><span>使用 ↑ ↓ 瀏覽</span><kbd>Esc</kbd> 關閉</footer></div></div>;
}

export function Icon({ name }: { name: IconName }): ReactNode {
  const paths: Record<IconName, ReactNode> = {
    box: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.29 7 8.71 5 8.71-5M12 22V12"/></>, receipt: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 8h8M8 12h8M8 16h5"/></>, activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>, database: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v7c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12v7c0 1.66 4.03 3 9 3s9-1.34 9-3v-7"/></>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></>, moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>, key: <><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l1.5 1.5M18.5 4.5 20 6"/></>, chevron: <path d="m9 18 6-6-6-6"/>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
