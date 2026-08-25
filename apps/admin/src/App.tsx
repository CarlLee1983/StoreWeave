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

  // 頁首動作先廣播給當前頁面：頁面接手（preventDefault）就由它自己開抽屜，
  // 沒人接才退回原本的「捲到頁內表單」。
  const runPageAction = (targetId: string) => {
    const handled = !window.dispatchEvent(new CustomEvent(`admin:action:${targetId}`, { cancelable: true }));
    if (!handled) document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
  };

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

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label={t('navigation')}>
        <div className="brand">
          <div className="brand__mark-wrap">
            <span className="brand__mark" aria-hidden="true"><Icon name="box" /></span>
          </div>
          <div className="brand__info">
            <span className="brand__title">StoreWeave</span>
            <span className="brand__env">Console</span>
          </div>
        </div>

        <nav className="sidebar__nav">
          {NAV_SECTIONS.map((section) => (
            <div className="nav-group" key={section}>
              <p className="nav-group__label">{t(section)}</p>
              {ROUTE_TABLE.filter((item) => item.section === section).map((item) => {
                const badge = item.badge?.(routeContext) ?? null;
                const isActive = route === item.path;
                return (
                  <button
                    key={item.path}
                    type="button"
                    aria-label={t(item.navLabel)}
                    className={`nav-link ${isActive ? 'nav-link--active' : ''}`}
                    onClick={() => go(item.path)}
                  >
                    <span className="nav-link__icon-wrap">
                      <Icon name={item.icon} />
                    </span>
                    <span className="nav-link__label">{t(item.navLabel)}</span>
                    {badge ? (
                      <span className={`nav-badge ${badge.variant === 'error' ? 'nav-badge--error' : ''}`}>
                        {badge.text}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar__footer">
          <div className="system-status-indicator">
            <span className="connection-indicator" />
            <span className="system-status-text">v0.1.0 · {t('online')}</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__left">
            <button
              type="button"
              className="command-trigger"
              onClick={() => setCommandOpen(true)}
              aria-label={t('openCommand')}
            >
              <Icon name="search" />
              <span>{t('searchActions')}</span>
              <kbd>⌘ K</kbd>
            </button>
          </div>

          <div className="topbar__utilities">
            <label className="locale-select" title={t('language')}>
              <span className="sr-only">{t('language')}</span>
              <select value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
                {LOCALES.map((value) => (
                  <option key={value} value={value}>
                    {value === 'zh-TW' ? '繁體中文' : value === 'en-US' ? 'English' : '日本語'}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={t('toggleTheme')}
              title={t('toggleTheme')}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>

            <button
              type="button"
              className={`token-trigger ${getToken() ? 'token-trigger--set' : ''}`}
              onClick={() => setTokenOpen(!tokenOpen)}
              aria-expanded={tokenOpen}
            >
              <Icon name="key" />
              <span>API Token</span>
            </button>

            {tokenOpen ? (
              <TokenPanel onTokenChange={() => setTokenVersion((value) => value + 1)} onClose={() => setTokenOpen(false)} />
            ) : null}

            {currentUser ? (
              <div className="user-profile-chip">
                <div className="user-profile-chip__avatar">
                  <Icon name="user" />
                </div>
                <div className="user-profile-chip__details">
                  <span className="user-profile-chip__name">{currentUser.displayName}</span>
                  <span className="user-profile-chip__role">{currentUser.role}</span>
                </div>
                <button
                  type="button"
                  className="icon-button logout-btn"
                  onClick={handleLogout}
                  aria-label={t('logout')}
                  title={t('logout')}
                >
                  <Icon name="logout" />
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <main className="content" key={`${tokenVersion}-${locale}`}>
          <div className="page-heading">
            <div>
              <h1>{t(currentPage.title)}</h1>
              <p>{t(currentPage.subtitle)}</p>
            </div>
            {currentPage.action ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => runPageAction(currentPage.action!.targetId)}
              >
                + {t(currentPage.action.label)}
              </button>
            ) : null}
          </div>
          {currentPage.render(routeContext)}
        </main>
      </div>

      {commandOpen ? <CommandPalette onNavigate={go} onClose={() => setCommandOpen(false)} /> : null}
    </div>
  );
}

function TokenPanel({ onTokenChange, onClose }: { onTokenChange: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(getToken());
  const save = () => { setToken(draft); onTokenChange(); onClose(); };
  const clear = () => { setToken(''); setDraft(''); onTokenChange(); };
  return (
    <div className="token-panel" role="dialog" aria-label={t('apiTokenSettings')}>
      <div className="token-panel__header">
        <p><Icon name="key" /> API Token</p>
        <span>{t('tokenStored')}</span>
      </div>
      <input
        autoFocus
        type="password"
        placeholder={t('enterToken')}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="token-panel__actions">
        <button type="button" className="button button--quiet" onClick={clear}>
          {t('clear')}
        </button>
        <button type="button" className="button button--primary" onClick={save}>
          {t('save')}
        </button>
      </div>
    </div>
  );
}

function CommandPalette({ onNavigate, onClose }: { onNavigate: (route: Route) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = ROUTE_TABLE.filter((item) => t(item.navLabel).toLowerCase().includes(query.toLowerCase()));
  const choose = (index: number) => matches[index] && onNavigate(matches[index].path);
  return (
    <div className="command-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('commandMenu')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette__search">
          <Icon name="search" />
          <input
            autoFocus
            placeholder={t('searchPages')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, matches.length - 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              }
              if (event.key === 'Enter') choose(active);
            }}
          />
        </div>
        <p className="command-palette__group-title">{t('goTo')}</p>
        <div className="command-palette__list">
          {matches.map((item, index) => (
            <button
              key={item.path}
              type="button"
              className={`command-palette__option ${index === active ? 'command-palette__option--active' : ''}`}
              onClick={() => onNavigate(item.path)}
            >
              <span className="command-palette__icon"><Icon name={item.icon} /></span>
              <span className="command-palette__label">{t(item.navLabel)}</span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
        <footer>
          <span>{t('navigateHint')}</span>
          <span><kbd>Esc</kbd> {t('close')}</span>
        </footer>
      </div>
    </div>
  );
}
