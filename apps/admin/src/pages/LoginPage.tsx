import { useState, type FormEvent } from 'react';
import { api, type CurrentUser } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';

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

  return (
    <div className="login-page">
      <form className="login-panel" onSubmit={handleSubmit}>
        <h1>{t('loginTitle')}</h1>
        <p>{t('loginSubtitle')}</p>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        <label>
          <span>{t('email')}</span>
          <input
            type="email"
            autoComplete="username"
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
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? t('loggingIn') : t('login')}
        </button>
      </form>
    </div>
  );
}
