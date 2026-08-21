import { useEffect, useState } from 'react';
import { getToken, setToken, type CurrentUser } from './api';
import { LOCALES, useI18n } from './i18n';
import { navigate, useRoute } from './router';
import { NAV_SECTIONS, ROUTE_TABLE, routeDefinition, type Route, type RouteContext } from './routes';
import { Icon } from './components/Icon';
import { LoginPage } from './pages/LoginPage';
import { Loading } from './components/Loading';
import { api } from './api';

export function App() {
  const { locale, setLocale, t } = useI18n();
  const route = useRoute();
  const [tokenVersion, setTokenVersion] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('storeweave.admin.theme') as 'dark' | 'light') || 'dark');
  const [commandOpen, setCommandOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [deadJobCount, setDeadJobCount] = useState(0);
  // 靜態 API token 存在時維持既有行為，直接進後台，不檢查帳號登入狀態
  const [authStatus, setAuthStatus] = useState<'checking' | 'authed' | 'anon'>(() => (getToken() ? 'authed' : 'checking'));
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    if (getToken()) return;
    api
      .me()
      .then((user) => { setCurrentUser(user); setAuthStatus('authed'); })
      .catch(() => setAuthStatus('anon'));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('storeweave.admin.theme', theme);
  }, [theme]);

  const refreshDeadJobCount = () => {
    api.listDeadJobs({ limit: 1 }).then((result) => setDeadJobCount(result.total)).catch(() => {});
  };

  useEffect(refreshDeadJobCount, [tokenVersion]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if (event.key === 'Escape') { setCommandOpen(false); setTokenOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const go = (nextRoute: Route) => { navigate(nextRoute); setCommandOpen(false); };
  const handleLoggedIn = (user: CurrentUser) => { setCurrentUser(user); setAuthStatus('authed'); setTokenVersion((value) => value + 1); };
  const handleLogout = () => { api.logout().catch(() => {}).finally(() => { setCurrentUser(null); setAuthStatus('anon'); }); };

  const routeContext: RouteContext = { deadJobCount, onDeadJobsChanged: refreshDeadJobCount };
  const currentPage = routeDefinition(route);

  if (authStatus === 'checking') {
    return <Loading />;
  }
  if (authStatus === 'anon') {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  return <div className="app-shell">
    <aside className="sidebar" aria-label={t('navigation')}>
      <div className="brand"><span className="brand__mark" aria-hidden="true"><Icon name="box" /></span><span>StoreWeave</span></div>
      <nav className="sidebar__nav">
        {NAV_SECTIONS.map((section) => <div className="nav-group" key={section}>
          <p className="nav-group__label">{t(section)}</p>
          {ROUTE_TABLE.filter((item) => item.section === section).map((item) => {
            const badge = item.badge?.(routeContext) ?? null;
            return <button key={item.path} type="button" aria-label={t(item.navLabel)} className={`nav-link ${route === item.path ? 'nav-link--active' : ''}`} onClick={() => go(item.path)}>
              <Icon name={item.icon} /><span>{t(item.navLabel)}</span>{badge ? <span className={`nav-badge ${badge.variant === 'error' ? 'nav-badge--error' : ''}`}>{badge.text}</span> : null}
            </button>;
          })}
        </div>)}
      </nav>
      <div className="sidebar__footer"><span className="connection-indicator" />v0.1.0 <span>{t('online')}</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <button type="button" className="command-trigger" onClick={() => setCommandOpen(true)} aria-label={t('openCommand')}><Icon name="search" /><span>{t('searchActions')}</span><kbd>⌘ K</kbd></button>
        <div className="topbar__utilities">
          <label className="locale-select" title={t('language')}><span className="sr-only">{t('language')}</span><select value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>{LOCALES.map((value) => <option key={value} value={value}>{value === 'zh-TW' ? '繁中' : value === 'en-US' ? 'EN' : '日本語'}</option>)}</select></label>
          <button type="button" className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t('toggleTheme')} title={t('toggleTheme')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button type="button" className={`token-trigger ${getToken() ? 'token-trigger--set' : ''}`} onClick={() => setTokenOpen(!tokenOpen)} aria-expanded={tokenOpen}><Icon name="key" />API Token</button>
          {tokenOpen ? <TokenPanel onTokenChange={() => setTokenVersion((value) => value + 1)} onClose={() => setTokenOpen(false)} /> : null}
          {currentUser ? <span className="user-badge"><span className="user-badge__name">{currentUser.displayName}</span><span className="user-badge__role">{currentUser.role}</span></span> : null}
          {currentUser ? <button type="button" className="icon-button" onClick={handleLogout} aria-label={t('logout')} title={t('logout')}><Icon name="logout" /></button> : null}
        </div>
      </header>
      <main className="content" key={`${tokenVersion}-${locale}`}>
        <div className="page-heading"><div><h1>{t(currentPage.title)}</h1><p>{t(currentPage.subtitle)}</p></div>{currentPage.action ? <button type="button" className="button button--primary" onClick={() => document.getElementById(currentPage.action!.targetId)?.scrollIntoView({ behavior: 'smooth' })}>+ {t(currentPage.action.label)}</button> : null}</div>
        {currentPage.render(routeContext)}
      </main>
    </div>
    {commandOpen ? <CommandPalette onNavigate={go} onClose={() => setCommandOpen(false)} /> : null}
  </div>;
}

function TokenPanel({ onTokenChange, onClose }: { onTokenChange: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(getToken());
  const save = () => { setToken(draft); onTokenChange(); onClose(); };
  const clear = () => { setToken(''); setDraft(''); onTokenChange(); };
  return <div className="token-panel" role="dialog" aria-label={t('apiTokenSettings')}><p>API Token</p><span>{t('tokenStored')}</span><input autoFocus type="password" placeholder={t('enterToken')} value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button type="button" className="button button--quiet" onClick={clear}>{t('clear')}</button><button type="button" className="button button--primary" onClick={save}>{t('save')}</button></div></div>;
}

function CommandPalette({ onNavigate, onClose }: { onNavigate: (route: Route) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = ROUTE_TABLE.filter((item) => t(item.navLabel).toLowerCase().includes(query.toLowerCase()));
  const choose = (index: number) => matches[index] && onNavigate(matches[index].path);
  return <div className="command-overlay" role="presentation" onMouseDown={onClose}><div className="command-palette" role="dialog" aria-modal="true" aria-label={t('commandMenu')} onMouseDown={(event) => event.stopPropagation()}><div className="command-palette__search"><Icon name="search" /><input autoFocus placeholder={t('searchPages')} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, matches.length - 1)); } if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); } if (event.key === 'Enter') choose(active); }} /></div><p>{t('goTo')}</p>{matches.map((item, index) => <button key={item.path} type="button" className={index === active ? 'command-palette__option--active' : ''} onClick={() => onNavigate(item.path)}><Icon name={item.icon} /><span>{t(item.navLabel)}</span><Icon name="chevron" /></button>)}<footer><span>{t('navigateHint')}</span><kbd>Esc</kbd> {t('close')}</footer></div></div>;
}
