import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getToken, setToken, type CurrentUser, type LoginResult } from './api';
import { LOCALES, useI18n } from './i18n';
import { navigate, useRoute } from './router';
import { NAV_SECTIONS, ROUTE_TABLE, firstVisibleRoute, routeDefinition, visibleRoutes,
  type Route, type RouteContext, type RouteDefinition } from './routes';
import { Icon } from './components/Icon';
import { LoginPage } from './pages/LoginPage';
import { Loading } from './components/Loading';
import { api } from './api';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './components/ui/dialog';
import { useAdminOperations } from './admin-operations';
import { deadJobKeys } from './query';

export function App() {
  const queryClient = useQueryClient();
  const adminOperations = useAdminOperations();
  const { locale, setLocale, t } = useI18n();
  const route = useRoute();
  const [tokenVersion, setTokenVersion] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('storeweave.admin.theme') as 'dark' | 'light') || 'dark');
  const [commandOpen, setCommandOpen] = useState(false);
  const commandReturnFocusRef = useRef<HTMLElement | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  // 靜態 API token 存在時維持既有行為，直接進後台，不檢查帳號登入狀態
  const [authStatus, setAuthStatus] = useState<'checking' | 'authed' | 'anon'>(() => (getToken() ? 'authed' : 'checking'));
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [mfaEnrolmentRequired, setMfaEnrolmentRequired] = useState(false);
  const identityEpoch = useRef(0);

  const prepareIdentity = async () => {
    const epoch = ++identityEpoch.current;
    setAuthStatus('checking');
    setCommandOpen(false);
    setCurrentUser(null);
    adminOperations.clearIdentity();
    await queryClient.cancelQueries();
    if (epoch !== identityEpoch.current) return epoch;
    queryClient.clear();
    return epoch;
  };

  useEffect(() => {
    if (getToken()) return;
    const epoch = identityEpoch.current;
    api
      .me()
      .then((user) => { if (epoch === identityEpoch.current) { setCurrentUser(user); setAuthStatus('authed'); } })
      .catch(() => { if (epoch === identityEpoch.current) setAuthStatus('anon'); });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('storeweave.admin.theme', theme);
  }, [theme]);

  const deadJobsQuery = useQuery({
    queryKey: deadJobKeys.list({ limit: 1, offset: 0 }),
    queryFn: ({ signal }) => api.listDeadJobs({ limit: 1, offset: 0 }, signal),
    enabled: authStatus === 'authed',
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        commandReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setCommandOpen(true);
      }
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
  const handleLoggedIn = async (login: LoginResult) => {
    const epoch = await prepareIdentity();
    if (epoch !== identityEpoch.current) return;
    // 登入的回應說得出「你是誰」，但看得到哪幾頁要問 me()——權限與模組是那一支的答案。
    const user = await api.me().catch(() => null);
    if (epoch !== identityEpoch.current) return;
    setCurrentUser(user);
    setAuthStatus(user ? 'authed' : 'anon');
    setTokenVersion((value) => value + 1);
    // 角色要求第二因素而帳號還沒註冊：直接把人帶到設定的地方（ADR 0044）。
    setMfaEnrolmentRequired(Boolean(login.mfaEnrolmentRequired));
    if (login.mfaEnrolmentRequired) navigate('account');
  };
  const handleLogout = async () => {
    const epoch = await prepareIdentity();
    api.logout().catch(() => {}).finally(() => {
      if (epoch === identityEpoch.current) setAuthStatus('anon');
    });
  };
  const handleTokenChange = async (token: string) => {
    const epoch = await prepareIdentity();
    if (epoch !== identityEpoch.current) return;
    setToken(token);
    setTokenVersion((value) => value + 1);
    if (token) {
      setAuthStatus('authed');
      return;
    }
    api.me().then((user) => {
      if (epoch === identityEpoch.current) { setCurrentUser(user); setAuthStatus('authed'); }
    }).catch(() => { if (epoch === identityEpoch.current) setAuthStatus('anon'); });
  };

  const routeContext: RouteContext = { deadJobCount: deadJobsQuery.data?.total ?? 0, deadJobError: deadJobsQuery.isError && !deadJobsQuery.data };
  const currentPage = routeDefinition(route);
  /**
   * 側欄只列出這個人做得到的事（B13 片3）。靜態 API token 進來的沒有身分可問，
   * 維持原本的全部顯示——隱藏選單從來不是權限檢查，後端仍然會擋。
   */
  const navRoutes: readonly RouteDefinition[] = useMemo(
    () => (currentUser ? visibleRoutes(currentUser) : ROUTE_TABLE),
    [currentUser],
  );

  // 預設頁被藏起來時退到第一列看得到的，而不是渲染一頁按不動的東西。
  useEffect(() => {
    if (authStatus !== 'authed' || navRoutes.some((entry) => entry.path === route)) return;
    const fallback = firstVisibleRoute(navRoutes);
    if (fallback) navigate(fallback);
  }, [authStatus, navRoutes, route]);

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
              {navRoutes.filter((item) => item.section === section).map((item) => {
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
                      <span className={`nav-badge ${badge.variant === 'error' ? 'nav-badge--error' : ''}`} aria-label={badge.text === '!' ? t('deadJobBadgeError') : undefined}>
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
              onClick={(event) => { commandReturnFocusRef.current = event.currentTarget; setCommandOpen(true); }}
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

            <Dialog open={tokenOpen} onOpenChange={setTokenOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className={`token-trigger ${getToken() ? 'token-trigger--set' : ''}`}
                  aria-expanded={tokenOpen}
                  aria-label={t('apiTokenSettings')}
                >
                  <Icon name="key" />
                  <span>API Token</span>
                </button>
              </DialogTrigger>
              {tokenOpen ? <TokenPanel onTokenChange={handleTokenChange} onClose={() => setTokenOpen(false)} /> : null}
            </Dialog>

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
          {mfaEnrolmentRequired ? (
            <p className="error-banner" role="status">{t('mfaEnrolmentRequired')}</p>
          ) : null}
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

      {commandOpen ? <CommandPalette routes={navRoutes} returnFocus={commandReturnFocusRef.current} onNavigate={go} onClose={() => setCommandOpen(false)} /> : null}
    </div>
  );
}

function TokenPanel({ onTokenChange, onClose }: { onTokenChange: (token: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(getToken());
  const save = () => { void onTokenChange(draft).then(onClose); };
  const clear = () => { setDraft(''); void onTokenChange(''); };
  return (
    <DialogContent className="token-panel" aria-describedby="token-panel-description">
      <div className="token-panel__header">
        <DialogTitle><Icon name="key" /> API Token</DialogTitle>
        <DialogDescription id="token-panel-description">{t('tokenStored')}</DialogDescription>
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
    </DialogContent>
  );
}

function CommandPalette({ routes, returnFocus, onNavigate, onClose }: { routes: readonly RouteDefinition[]; returnFocus: HTMLElement | null; onNavigate: (route: Route) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = routes.filter((item) => t(item.navLabel).toLowerCase().includes(query.toLowerCase()));
  const activeOptionId = matches[active] ? `command-option-${matches[active].path}` : undefined;
  useEffect(() => { document.getElementById(activeOptionId ?? '')?.scrollIntoView?.({ block: 'nearest' }); }, [activeOptionId]);
  const choose = (index: number) => matches[index] && onNavigate(matches[index].path);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="command-palette"
        aria-describedby="command-palette-hint"
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus?.focus(); }}
      >
        <DialogTitle className="sr-only">{t('commandMenu')}</DialogTitle>
        <div className="command-palette__search">
          <Icon name="search" />
          <input
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-options"
            aria-activedescendant={activeOptionId}
            placeholder={t('searchPages')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, Math.max(matches.length - 1, 0)));
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
        <div id="command-options" className="command-palette__list" role="listbox" aria-label={t('goTo')}>
          {matches.map((item, index) => (
            <button
              id={`command-option-${item.path}`}
              key={item.path}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className={`command-palette__option ${index === active ? 'command-palette__option--active' : ''}`}
              onClick={() => onNavigate(item.path)}
            >
              <span className="command-palette__icon"><Icon name={item.icon} /></span>
              <span className="command-palette__label">{t(item.navLabel)}</span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
        <footer id="command-palette-hint">
          <span>{t('navigateHint')}</span>
          <span><kbd>Esc</kbd> {t('close')}</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
