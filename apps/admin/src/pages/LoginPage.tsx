import { useState, type FormEvent } from 'react';
import { api, type CurrentUser } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Icon } from '../components/Icon';

/** 帳號密碼登入頁；未登入且沒有靜態 API token 時顯示。 */
export function LoginPage({ onLoggedIn }: { onLoggedIn: (user: CurrentUser) => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await api.login(email, password);
      onLoggedIn(user);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const fillDemoAccount = (demoEmail: string, demoPass: string) => {
    setEmail(demoEmail);
    setPassword(demoPass);
    setError(null);
  };

  return (
    <div className="login-page">
      <div className="login-backdrop-glow" aria-hidden="true" />
      <div className="login-container">
        <div className="login-brand-header">
          <div className="login-brand-icon">
            <Icon name="box" />
          </div>
          <div className="login-brand-text">
            <h2>StoreWeave</h2>
            <span>Commerce Operating System</span>
          </div>
        </div>

        <form className="login-panel" onSubmit={handleSubmit}>
          <div className="login-panel__title-group">
            <h1>{t('loginTitle')}</h1>
            <p>{t('loginSubtitle')}</p>
          </div>

          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <div className="login-field-group">
            <label>
              <span>{t('email')}</span>
              <input
                type="email"
                autoComplete="username"
                placeholder="operator@storeweave.test"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label>
              <span>{t('password')}</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          </div>

          <button type="submit" className="button button--primary login-submit-btn" disabled={submitting}>
            {submitting ? t('loggingIn') : t('login')}
          </button>

          <div className="login-demo-presets">
            <p className="login-demo-presets__label">
              <Icon name="sparkles" /> 快速填入測試示範帳號
            </p>
            <div className="login-demo-buttons">
              <button
                type="button"
                className="demo-pill-btn demo-pill-btn--admin"
                onClick={() => fillDemoAccount('admin@storeweave.test', 'AdminPassword123!')}
              >
                <Icon name="shield" /> 總部店長 (Admin)
              </button>
              <button
                type="button"
                className="demo-pill-btn"
                onClick={() => fillDemoAccount('gold_vip@woven-day.test', 'CustomerPassword123!')}
              >
                <Icon name="user" /> 金卡 VIP 顧客
              </button>
            </div>
          </div>
        </form>

        <footer className="login-footer">
          <span>StoreWeave Engine v0.1.0</span>
          <span>·</span>
          <span>Security Hardened Session</span>
        </footer>
      </div>
    </div>
  );
}
