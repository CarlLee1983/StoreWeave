import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MfaStatus } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Icon } from '../components/Icon';
import { CopyButton } from '../components/CopyButton';
import { accountKeys } from '../query';

/** 帳號自助頁：密碼、電子郵件、登入裝置、第二因素（B13 片5）。 */
export function AccountPage() {
  const { t } = useI18n();
  return <section>
    <PasswordPanel />
    <EmailPanel />
    <SessionsPanel />
    <MfaPanel />
  </section>;
}

function PasswordPanel() {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setDone(false);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return <section className="account-panel">
    <div className="section-heading"><h2>{t('changePassword')}</h2></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {done ? <p role="status"><Icon name="check" /> {t('changePassword')}</p> : null}
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>{t('currentPassword')}<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label>{t('newPassword')}<input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <button type="submit" className="button button--primary" disabled={submitting}>{submitting ? t('loading') : t('changePassword')}</button>
    </form>
  </section>;
}

function EmailPanel() {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setDone(false);
    try {
      await api.changeEmail({ currentPassword, newEmail });
      setDone(true);
      setCurrentPassword('');
      setNewEmail('');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return <section className="account-panel">
    <div className="section-heading"><h2>{t('changeEmail')}</h2></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {done ? <p role="status"><Icon name="check" /> {t('changeEmail')}</p> : null}
    <form className="inline-form" onSubmit={handleSubmit}>
      <label>{t('currentPassword')}<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label>{t('newEmail')}<input type="email" required value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></label>
      <button type="submit" className="button button--primary" disabled={submitting}>{submitting ? t('loading') : t('changeEmail')}</button>
    </form>
  </section>;
}

function SessionsPanel() {
  const { t } = useI18n();
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<'resend' | 'revoke' | null>(null);
  const [pending, setPending] = useState<'resend' | 'revoke' | null>(null);

  const run = async (kind: 'resend' | 'revoke', action: () => Promise<{ accepted: true }>) => {
    setPending(kind);
    setError(null);
    setDone(null);
    try {
      await action();
      setDone(kind);
    } catch (err) {
      setError(err);
    } finally {
      setPending(null);
    }
  };

  return <section className="account-panel">
    <div className="section-heading"><h2>{t('revokeOtherSessions')}</h2></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {done ? <p role="status"><Icon name="check" /> {done === 'resend' ? t('resendVerification') : t('revokeOtherSessions')}</p> : null}
    <div className="inline-form">
      <button type="button" className="button" disabled={!!pending} onClick={() => void run('resend', () => api.resendVerification())}>{t('resendVerification')}</button>
      <button type="button" className="button button--primary" disabled={!!pending} onClick={() => void run('revoke', () => api.revokeOtherSessions())}>{t('revokeOtherSessions')}</button>
    </div>
  </section>;
}

function MfaPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: accountKeys.mfa, queryFn: ({ signal }) => api.mfaStatus(signal) });

  // 尚未確認的 enrollment 金鑰與復原碼只留在畫面狀態，絕不重新查詢也絕不落地儲存。
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [regenerateCode, setRegenerateCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: accountKeys.mfa });

  const enrollMutation = useMutation({ mutationFn: () => api.mfaEnroll() });
  const confirmMutation = useMutation({ mutationFn: (code: string) => api.mfaConfirm(code) });
  const regenerateMutation = useMutation({ mutationFn: (code: string) => api.mfaRecoveryCodes(code) });
  const disableMutation = useMutation({ mutationFn: (body: { currentPassword: string; code: string }) => api.mfaDisable(body) });

  // mutateAsync 的拒絕已經由對應 mutation 的 isError / ErrorBanner 呈現，這裡只需要吞掉 rejection 避免 unhandled promise。
  const startEnroll = async () => {
    try {
      setEnrollment(await enrollMutation.mutateAsync());
    } catch {
      // 已由 ErrorBanner 呈現
    }
  };

  const confirmEnroll = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await confirmMutation.mutateAsync(confirmCode);
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
      setConfirmCode('');
      invalidate();
    } catch {
      // 已由 ErrorBanner 呈現
    }
  };

  const regenerate = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await regenerateMutation.mutateAsync(regenerateCode);
      setRecoveryCodes(result.recoveryCodes);
      setRegenerateCode('');
      invalidate();
    } catch {
      // 已由 ErrorBanner 呈現
    }
  };

  const disable = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await disableMutation.mutateAsync({ currentPassword: disablePassword, code: disableCode });
      setDisablePassword('');
      setDisableCode('');
      setRecoveryCodes(null);
      invalidate();
    } catch {
      // 已由 ErrorBanner 呈現
    }
  };

  return <section className="account-panel">
    <div className="section-heading"><h2>{t('mfaSection')}</h2></div>
    {statusQuery.isError ? <ErrorBanner error={statusQuery.error} onRetry={() => void statusQuery.refetch()} /> : null}
    {enrollMutation.isError ? <ErrorBanner error={enrollMutation.error} onDismiss={() => enrollMutation.reset()} /> : null}
    {confirmMutation.isError ? <ErrorBanner error={confirmMutation.error} onDismiss={() => confirmMutation.reset()} /> : null}
    {regenerateMutation.isError ? <ErrorBanner error={regenerateMutation.error} onDismiss={() => regenerateMutation.reset()} /> : null}
    {disableMutation.isError ? <ErrorBanner error={disableMutation.error} onDismiss={() => disableMutation.reset()} /> : null}
    {disableMutation.isSuccess ? <p role="status"><Icon name="check" /> {t('mfaDisable')}</p> : null}

    {statusQuery.isLoading ? <Loading /> : statusQuery.isSuccess ? <MfaBody
      status={statusQuery.data}
      enrollment={enrollment}
      recoveryCodes={recoveryCodes}
      confirmCode={confirmCode}
      onConfirmCodeChange={setConfirmCode}
      regenerateCode={regenerateCode}
      onRegenerateCodeChange={setRegenerateCode}
      disablePassword={disablePassword}
      onDisablePasswordChange={setDisablePassword}
      disableCode={disableCode}
      onDisableCodeChange={setDisableCode}
      onStartEnroll={() => void startEnroll()}
      onConfirmEnroll={confirmEnroll}
      onRegenerate={regenerate}
      onDisable={disable}
      enrolling={enrollMutation.isPending}
      confirming={confirmMutation.isPending}
      regenerating={regenerateMutation.isPending}
      disabling={disableMutation.isPending}
    /> : null}
  </section>;
}

function MfaBody({ status, enrollment, recoveryCodes, confirmCode, onConfirmCodeChange, regenerateCode, onRegenerateCodeChange, disablePassword, onDisablePasswordChange, disableCode, onDisableCodeChange, onStartEnroll, onConfirmEnroll, onRegenerate, onDisable, enrolling, confirming, regenerating, disabling }: {
  status: MfaStatus;
  enrollment: { secret: string; uri: string } | null;
  recoveryCodes: string[] | null;
  confirmCode: string;
  onConfirmCodeChange: (value: string) => void;
  regenerateCode: string;
  onRegenerateCodeChange: (value: string) => void;
  disablePassword: string;
  onDisablePasswordChange: (value: string) => void;
  disableCode: string;
  onDisableCodeChange: (value: string) => void;
  onStartEnroll: () => void;
  onConfirmEnroll: (event: FormEvent) => void;
  onRegenerate: (event: FormEvent) => void;
  onDisable: (event: FormEvent) => void;
  enrolling: boolean;
  confirming: boolean;
  regenerating: boolean;
  disabling: boolean;
}) {
  const { t } = useI18n();

  if (recoveryCodes) {
    return <div>
      <p>{t('recoveryCodesOnce')}</p>
      <ul className="mono">{recoveryCodes.map((code) => <li key={code}>{code}</li>)}</ul>
    </div>;
  }

  if (!status.enrolled) {
    return <div>
      <p>{t('mfaNotEnrolled')}</p>
      {enrollment ? <>
        <dl className="order-totals"><dt>{t('mfaSecret')}</dt><dd className="mono">{enrollment.secret} <CopyButton text={enrollment.secret} label={t('mfaSecret')} /></dd></dl>
        <form className="inline-form" onSubmit={onConfirmEnroll}>
          <label>{t('verificationCode')}<input value={confirmCode} onChange={(event) => onConfirmCodeChange(event.target.value)} required /></label>
          <button type="submit" className="button button--primary" disabled={confirming}>{confirming ? t('loading') : t('mfaConfirm')}</button>
        </form>
      </> : <button type="button" className="button button--primary" disabled={enrolling} onClick={onStartEnroll}>{enrolling ? t('loading') : t('mfaEnroll')}</button>}
    </div>;
  }

  return <div>
    <p><Icon name="check" /> {t('mfaEnrolled')}</p>
    <dl className="order-totals"><dt>{t('recoveryCodesRemaining')}</dt><dd>{status.recoveryCodesRemaining}</dd></dl>

    <form className="inline-form" onSubmit={onRegenerate}>
      <label>{t('verificationCode')}<input value={regenerateCode} onChange={(event) => onRegenerateCodeChange(event.target.value)} required /></label>
      <button type="submit" className="button" disabled={regenerating}>{regenerating ? t('loading') : t('regenerateRecoveryCodes')}</button>
    </form>

    <form className="inline-form" onSubmit={onDisable}>
      <label>{t('currentPassword')}<input type="password" autoComplete="current-password" value={disablePassword} onChange={(event) => onDisablePasswordChange(event.target.value)} required /></label>
      <label>{t('verificationCode')}<input value={disableCode} onChange={(event) => onDisableCodeChange(event.target.value)} required /></label>
      <button type="submit" className="button button--danger" disabled={disabling}>{disabling ? t('loading') : t('mfaDisable')}</button>
    </form>
  </div>;
}
