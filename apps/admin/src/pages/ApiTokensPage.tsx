import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiToken, type IssuedApiToken } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { CopyButton } from '../components/CopyButton';
import { apiTokenKeys } from '../query';

const ROLES = ['admin', 'staff', 'readonly', 'mcp'] as const;
type Role = (typeof ROLES)[number];

export function ApiTokensPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const tokensQuery = useQuery({ queryKey: apiTokenKeys.list, queryFn: ({ signal }) => api.listApiTokens(signal) });
  const [issuing, setIssuing] = useState(false);
  // 秘密只活在這個 state；一旦被關掉或整頁卸載就沒有第二次讀回的機會，不進 query cache 也不落地。
  const [issuedSecret, setIssuedSecret] = useState<IssuedApiToken | null>(null);
  const [terminalError, setTerminalError] = useState<unknown>(null);

  // 頁首那顆「簽發 Token」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開表單，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openIssue = (event: Event) => { event.preventDefault(); setIssuing(true); };
    window.addEventListener('admin:action:issue-api-token', openIssue);
    return () => window.removeEventListener('admin:action:issue-api-token', openIssue);
  }, []);

  const issueMutation = useMutation({
    mutationFn: (body: { name: string; role: Role; ttlDays: number }) => api.issueApiToken(body, crypto.randomUUID()),
    onSuccess: (result) => {
      setIssuedSecret(result);
      setIssuing(false);
      void queryClient.invalidateQueries({ queryKey: apiTokenKeys.list });
    },
    onError: (error) => setTerminalError(error),
  });
  const revokeMutation = useMutation({
    mutationFn: (name: string) => api.revokeApiToken(name, crypto.randomUUID()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiTokenKeys.list }),
    onError: (error) => setTerminalError(error),
  });

  return <section>
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {tokensQuery.isError ? <ErrorBanner error={tokensQuery.error} onRetry={() => void tokensQuery.refetch()} /> : null}
    {issuedSecret ? <div className="account-panel" role="status">
      <p>{t('tokenSecretOnce')}</p>
      <div className="toolbar"><code className="mono">{issuedSecret.secret}</code><CopyButton text={issuedSecret.secret} label={issuedSecret.name} /></div>
      <button className="button button--quiet" type="button" onClick={() => setIssuedSecret(null)}>{t('cancel')}</button>
    </div> : null}
    {issuing ? <IssueTokenForm submitting={issueMutation.isPending} onCancel={() => setIssuing(false)} onSubmit={(body) => issueMutation.mutate(body)} /> : null}
    {tokensQuery.isLoading ? <Loading /> : tokensQuery.isSuccess && tokensQuery.data.items.length === 0 ? <EmptyState icon="key" title={t('noApiTokens')} /> : tokensQuery.isSuccess ? <div className="table-wrap"><table className="data-table data-table--fixed observability-table">
      <thead><tr>
        <th style={{ width: '20%' }}>{t('name')}</th><th style={{ width: '14%' }}>{t('role')}</th><th style={{ width: '16%' }}>{t('createdAt')}</th><th style={{ width: '16%' }}>{t('expiresAt')}</th><th style={{ width: '16%' }}>{t('lastUsedAt')}</th><th style={{ width: '10%' }}>{t('status')}</th><th style={{ width: '8%' }} className="col-actions">{t('actions')}</th>
      </tr></thead>
      <tbody>{tokensQuery.data.items.map((token) => <TokenRow key={token.id} token={token} blocked={tokensQuery.isFetching || revokeMutation.isPending} onRevoke={(name) => revokeMutation.mutate(name)} />)}</tbody>
    </table></div> : null}
  </section>;
}

function TokenRow({ token, blocked, onRevoke }: { token: ApiToken; blocked: boolean; onRevoke: (name: string) => void }) {
  const { t, formatDateTime } = useI18n();
  const revoked = token.revokedAt !== null;
  return <tr>
    <td>{token.name}</td><td>{token.role}</td><td className="mono">{formatDateTime(token.createdAt)}</td>
    <td className="mono">{formatDateTime(token.expiresAt)}</td>
    <td className="mono">{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : t('none')}</td>
    <td>{revoked ? formatDateTime(token.revokedAt as string) : t('active')}</td>
    <td className="col-actions">{revoked ? null : <button className="button button--quiet" type="button" disabled={blocked} onClick={() => onRevoke(token.name)}><Icon name="ban" /> {t('revoke')}</button>}</td>
  </tr>;
}

function IssueTokenForm({ submitting, onCancel, onSubmit }: { submitting: boolean; onCancel: () => void; onSubmit: (body: { name: string; role: Role; ttlDays: number }) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [ttlDays, setTtlDays] = useState(30);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ name: name.trim(), role, ttlDays });
  };

  return <form id="issue-api-token" className="form-panel" aria-label={t('issueApiToken')} onSubmit={submit}>
    <div className="form-field">
      <label htmlFor="api-token-name"><span className="field-label-text">{t('name')}</span></label>
      <input id="api-token-name" aria-label={t('name')} value={name} onChange={(event) => setName(event.target.value)} required />
    </div>
    <div className="form-grid-2">
      <div className="form-field">
        <label htmlFor="api-token-role"><span className="field-label-text">{t('role')}</span></label>
        <select id="api-token-role" aria-label={t('role')} value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor="api-token-ttl"><span className="field-label-text">{t('ttlDays')}</span></label>
        <input id="api-token-ttl" aria-label={t('ttlDays')} type="number" min={1} max={365} value={ttlDays} onChange={(event) => setTtlDays(Number(event.target.value))} />
      </div>
    </div>
    <footer className="toolbar">
      <button className="button" type="button" onClick={onCancel}>{t('cancel')}</button>
      <button className="button button--primary" type="submit" disabled={submitting || !name.trim()}>{submitting ? t('loading') : t('create')}</button>
    </footer>
  </form>;
}
