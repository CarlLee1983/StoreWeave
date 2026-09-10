import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Operator } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { operatorKeys } from '../query';

const EMPTY_FORM = { email: '', password: '', displayName: '', role: 'staff' };

export function OperatorsPage() {
  const { t, formatDateTime } = useI18n();
  const [creating, setCreating] = useState(false);
  const [rowError, setRowError] = useState<unknown>(null);
  const input = { limit: 100, offset: 0 };
  const operatorsQuery = useQuery({ queryKey: operatorKeys.list(input), queryFn: ({ signal }) => api.listOperators(input, signal) });
  const operators = operatorsQuery.isSuccess ? operatorsQuery.data.items : [];

  // 頁首那顆「建立操作者」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開表單，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => { event.preventDefault(); setCreating(true); };
    window.addEventListener('admin:action:create-operator', openCreate);
    return () => window.removeEventListener('admin:action:create-operator', openCreate);
  }, []);

  return <section>
    {rowError ? <ErrorBanner error={rowError} onDismiss={() => setRowError(null)} /> : null}
    {operatorsQuery.isError ? <ErrorBanner error={operatorsQuery.error} onRetry={() => void operatorsQuery.refetch()} /> : null}
    {creating ? <CreateOperatorForm onClose={() => setCreating(false)} /> : null}
    {operatorsQuery.isLoading ? <Loading /> : operatorsQuery.isSuccess && operators.length === 0 ? <EmptyState icon="user" title={t('noOperators')} /> : operatorsQuery.isSuccess ? <div className="table-wrap"><table className="data-table data-table--fixed observability-table">
      <thead><tr>
        <th style={{ width: '22%' }}>{t('email')}</th><th style={{ width: '18%' }}>{t('displayName')}</th><th style={{ width: '12%' }}>{t('role')}</th><th style={{ width: '14%' }}>{t('createdAt')}</th><th style={{ width: '14%' }}>{t('lastLoginAt')}</th><th style={{ width: '10%' }}>{t('status')}</th><th style={{ width: '10%' }} className="col-actions">{t('actions')}</th>
      </tr></thead>
      <tbody>{operators.map((operator) => <OperatorRow key={operator.id} operator={operator} disabled={operatorsQuery.isFetching} onError={setRowError} />)}</tbody>
    </table></div> : null}
  </section>;
}

function OperatorRow({ operator, disabled, onError }: { operator: Operator; disabled: boolean; onError: (error: unknown) => void }) {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const nextStatus: Operator['status'] = operator.status === 'active' ? 'disabled' : 'active';
  const toggle = async () => {
    setSubmitting(true);
    try {
      await api.setOperatorStatus(operator.id, nextStatus, crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: operatorKeys.lists });
    } catch (error) {
      onError(error);
    } finally {
      setSubmitting(false);
    }
  };
  return <tr>
    <td><span className="cell-truncate" title={operator.email}>{operator.email}</span></td>
    <td>{operator.displayName}</td>
    <td>{operator.role}</td>
    <td className="mono">{formatDateTime(operator.createdAt)}</td>
    <td className="mono">{operator.lastLoginAt ? formatDateTime(operator.lastLoginAt) : t('none')}</td>
    <td><StatusBadge value={operator.status} label={operator.status === 'active' ? t('accountActive') : t('accountDisabled')} /></td>
    <td className="col-actions"><button type="button" className="button button--quiet" disabled={disabled || submitting} onClick={() => void toggle()}><Icon name={operator.status === 'active' ? 'pause' : 'play'} /> {operator.status === 'active' ? t('disable') : t('enable')}</button></td>
  </tr>;
}

/** 建立操作者表單：由頁首動作事件開啟，容器保留固定 id 供 routes 對焦。 */
function CreateOperatorForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<unknown>(null);
  const mutation = useMutation({
    mutationFn: () => api.createOperator({ email: form.email.trim(), password: form.password, displayName: form.displayName.trim(), role: form.role }, crypto.randomUUID()),
  });
  const update = <K extends keyof typeof EMPTY_FORM>(key: K, value: typeof EMPTY_FORM[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setError(null);
    try {
      await mutation.mutateAsync();
      void queryClient.invalidateQueries({ queryKey: operatorKeys.lists });
      setForm(EMPTY_FORM);
      onClose();
    } catch (caught) {
      setError(caught);
    }
  };

  return <section id="create-operator" className="account-panel" aria-label={t('createOperator')}>
    <form className="form-panel" onSubmit={(event) => void submit(event)}>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <label>{t('email')}<input type="email" required aria-label={t('email')} value={form.email} onChange={(event) => update('email', event.target.value)} /></label>
      <label>{t('displayName')}<input required aria-label={t('displayName')} value={form.displayName} onChange={(event) => update('displayName', event.target.value)} /></label>
      <label>{t('role')}<select aria-label={t('role')} value={form.role} onChange={(event) => update('role', event.target.value)}>
        <option value="admin">admin</option><option value="staff">staff</option><option value="readonly">readonly</option>
      </select></label>
      <label>{t('password')}<input type="password" required minLength={12} aria-label={t('password')} value={form.password} onChange={(event) => update('password', event.target.value)} /></label>
      <footer className="product-drawer-footer">
        <button type="button" className="button" onClick={onClose}>{t('cancel')}</button>
        <button type="submit" className="button button--primary" disabled={mutation.isPending}>{mutation.isPending ? t('loading') : t('create')}</button>
      </footer>
    </form>
  </section>;
}
