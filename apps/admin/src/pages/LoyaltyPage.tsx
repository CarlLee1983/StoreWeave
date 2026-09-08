import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RewardSettings, type Tier } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Icon } from '../components/Icon';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { loyaltyKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

/**
 * 基點只活在契約裡。店員看到的是「回饋 1%」與「1.5 倍」——
 * 把 100 與 15000 攤給人看，遲早有人把倍率填成 1.5。
 */
const toPercent = (basisPoints: number) => String(basisPoints / 100);
const toMultiplier = (basisPoints: number) => String(basisPoints / 10_000);

/**
 * 小數位數是硬界線，不是四捨五入的對象。放行 1.005 再 round 成 100 基點，
 * 等於把店員打的數字靜默改掉——寧可退回去讓他自己決定要 1% 還是 1.01%。
 */
function basisPointsFrom(raw: string, unit: number, decimals: number, min: number, max: number): number | null {
  const text = raw.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(text)) return null;
  const value = Math.round(Number(text) * unit);
  return value >= min && value <= max ? value : null;
}

const basisPointsFromPercent = (raw: string) => basisPointsFrom(raw, 100, 2, 0, 10_000);
const basisPointsFromMultiplier = (raw: string) => basisPointsFrom(raw, 10_000, 4, 10_000, 100_000);

type RewardSettingsPatch = Parameters<typeof api.updateRewardSettings>[0];
type RewardSettingsDraft = { accrual: string; effectiveAfterDays: string; neverExpires: boolean; expiresAfterDays: string; expiryNoticeDays: string };
type TierDraft = { name: string; thresholdPoints: string; multiplier: string };
type LoyaltyOperation = AdminOperation & (
  | { kind: 'settings'; request: RewardSettingsPatch; draft: RewardSettingsDraft; preview: { changed: string[] } }
  | { kind: 'tier-save'; request: Tier; draft: TierDraft }
  | { kind: 'tier-remove'; tierName: string; request: { name: string }; preview: { name: string } }
);
type LoyaltyOperationEntry = AdminOperationEntry<LoyaltyOperation>;
type LoyaltyOperationResult = Awaited<ReturnType<typeof executeAdminOperation<LoyaltyOperation, RewardSettings | Tier | { items: Tier[] }>>>;
type RunLoyaltyOperation = (operation: LoyaltyOperation, retryEntry?: LoyaltyOperationEntry) => Promise<LoyaltyOperationResult>;
function isLoyaltyOperation(entry: AdminOperationEntry): entry is LoyaltyOperationEntry {
  return entry.operation.area === 'loyalty' && ['settings', 'tier-save', 'tier-remove'].includes((entry.operation as LoyaltyOperation).kind);
}

/** 上下界跟著 dto.ts 的 zod 範圍走；少一道，後端就會用英文 zod 訊息回一個 400。 */
function wholeNumber(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : null;
}

export function LoyaltyPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const operations = useAdminOperations();
  const operationEntries = useAdminOperationEntries().filter(isLoyaltyOperation);
  const [operationError, setOperationError] = useState<unknown>(null);
  const settingsQuery = useQuery({ queryKey: loyaltyKeys.settings, queryFn: ({ signal }) => api.getRewardSettings(signal) });
  const tiersQuery = useQuery({ queryKey: loyaltyKeys.tiers, queryFn: ({ signal }) => api.listTiers(signal) });
  const settings = settingsQuery.data;
  const tiers = tiersQuery.data?.items ?? [];
  const commandMutation = useMutation<RewardSettings | Tier | { items: Tier[] }, unknown, LoyaltyOperation>({ mutationFn: (operation) => {
    switch (operation.kind) {
      case 'settings': return api.updateRewardSettings(operation.request, operation.idempotencyKey);
      case 'tier-save': return api.saveTier(operation.request, operation.idempotencyKey);
      case 'tier-remove': return api.removeTier(operation.tierName, operation.idempotencyKey);
    }
  } });
  const runOperation: RunLoyaltyOperation = (operation, retryEntry) => executeAdminOperation(operations, operation,
    (live) => commandMutation.mutateAsync(live),
    (_result, live) => { void queryClient.invalidateQueries({ queryKey: live.kind === 'settings' ? loyaltyKeys.settings : loyaltyKeys.tiers }); return undefined; }, retryEntry);
  const retryOperation = async (entry: LoyaltyOperationEntry) => {
    const result = await runOperation(entry.operation, entry);
    if (result.state === 'rejected') setOperationError(result.error);
  };
  return <section>
    {operationError ? <ErrorBanner error={operationError} onDismiss={() => setOperationError(null)} /> : null}
    {operationEntries.map((entry) => <div className="error-banner" role="status" key={entry.operation.idempotencyKey}>
      <span>{entry.operation.kind === 'settings' ? `${t('rewardSettings')}: ${[
        entry.operation.request.accrualBasisPoints === undefined ? null : `${t('accrualPercent')} ${entry.operation.draft.accrual}%`,
        entry.operation.request.effectiveAfterDays === undefined ? null : `${t('effectiveAfterDays')} ${entry.operation.draft.effectiveAfterDays}`,
        entry.operation.request.expiresAfterDays === undefined ? null : entry.operation.draft.neverExpires ? t('neverExpires') : `${t('expiresAfterDays')} ${entry.operation.draft.expiresAfterDays}`,
        entry.operation.request.expiryNoticeDays === undefined ? null : `${t('expiryNoticeDays')} ${entry.operation.draft.expiryNoticeDays}`,
      ].filter(Boolean).join(' · ')}` : entry.operation.kind === 'tier-save' ? `${t('saveTier')}: ${entry.operation.request.name}` : `${t('remove')}: ${entry.operation.preview.name}`}</span>
      {entry.error instanceof Error ? <span>{entry.error.message}</span> : null}
      {entry.phase === 'unknown' ? <button type="button" className="button button--quiet" onClick={() => void retryOperation(entry)}>{t('retryOriginalOperation')}</button> : null}
    </div>)}
    <p className="muted">{t('loyaltyNoRetroHint')}</p>
    {settingsQuery.isLoading ? <Loading /> : settingsQuery.isError ? <ErrorBanner error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} /> : settings ? <RewardSettingsForm settings={settings} onRunOperation={runOperation} recovery={operationEntries.find((entry) => entry.operation.kind === 'settings') ?? null} /> : null}
    {tiersQuery.isLoading ? <Loading /> : tiersQuery.isError ? <ErrorBanner error={tiersQuery.error} onRetry={() => void tiersQuery.refetch()} /> : tiersQuery.isSuccess ? <TierSection tiers={tiers} onRunOperation={runOperation} recoveries={operationEntries.filter((entry) => entry.operation.kind === 'tier-save' || entry.operation.kind === 'tier-remove')} /> : null}
  </section>;
}

function RewardSettingsForm({ settings, onRunOperation, recovery }: { settings: RewardSettings; onRunOperation: RunLoyaltyOperation; recovery: LoyaltyOperationEntry | null }) {
  const { t } = useI18n();
  const [accrual, setAccrual] = useState(() => toPercent(settings.accrualBasisPoints));
  const [effectiveAfterDays, setEffectiveAfterDays] = useState(String(settings.effectiveAfterDays));
  const [neverExpires, setNeverExpires] = useState(settings.expiresAfterDays === null);
  const [expiresAfterDays, setExpiresAfterDays] = useState(settings.expiresAfterDays === null ? '' : String(settings.expiresAfterDays));
  const [expiryNoticeDays, setExpiryNoticeDays] = useState(String(settings.expiryNoticeDays));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = recovery !== null;
  useEffect(() => {
    if (recovery?.operation.kind !== 'settings') return;
    const draft = recovery.operation.draft;
    setAccrual(draft.accrual); setEffectiveAfterDays(draft.effectiveAfterDays); setNeverExpires(draft.neverExpires);
    setExpiresAfterDays(draft.expiresAfterDays); setExpiryNoticeDays(draft.expiryNoticeDays);
  }, [recovery]);

  const submit = async () => {
    const accrualBasisPoints = basisPointsFromPercent(accrual);
    const effective = wholeNumber(effectiveAfterDays, 0, 365);
    const notice = wholeNumber(expiryNoticeDays, 1, 365);
    const expires = neverExpires ? null : wholeNumber(expiresAfterDays, 1, 3_650);
    if (accrualBasisPoints === null || effective === null || notice === null || (!neverExpires && expires === null)) {
      setError(new Error(t('invalidRewardSettings')));
      return;
    }
    const patch: Parameters<typeof api.updateRewardSettings>[0] = {};
    if (accrualBasisPoints !== settings.accrualBasisPoints) patch.accrualBasisPoints = accrualBasisPoints;
    if (effective !== settings.effectiveAfterDays) patch.effectiveAfterDays = effective;
    if (expires !== settings.expiresAfterDays) patch.expiresAfterDays = expires;
    if (notice !== settings.expiryNoticeDays) patch.expiryNoticeDays = notice;
    if (Object.keys(patch).length === 0) {
      setError(new Error(t('noFieldsChanged')));
      return;
    }
    setSubmitting(true); setError(null);
    const draft = { accrual, effectiveAfterDays, neverExpires, expiresAfterDays, expiryNoticeDays };
    const changed = [
      patch.accrualBasisPoints === undefined ? null : `${t('accrualPercent')} ${draft.accrual}%`,
      patch.effectiveAfterDays === undefined ? null : `${t('effectiveAfterDays')} ${draft.effectiveAfterDays}`,
      patch.expiresAfterDays === undefined ? null : draft.neverExpires ? t('neverExpires') : `${t('expiresAfterDays')} ${draft.expiresAfterDays}`,
      patch.expiryNoticeDays === undefined ? null : `${t('expiryNoticeDays')} ${draft.expiryNoticeDays}`,
    ].filter((value): value is string => value !== null);
    const result = await onRunOperation({ area: 'loyalty', scope: 'loyalty:settings', kind: 'settings', request: patch, draft, preview: { changed }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };

  return <form className="form-panel" aria-label={t('rewardSettings')} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h2>{t('rewardSettings')}</h2>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <fieldset className="form-grid" disabled={locked || submitting} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
      <label>{t('accrualPercent')}<input aria-label={t('accrualPercent')} value={accrual} onChange={(event) => setAccrual(event.target.value)} /></label>
      <label>{t('effectiveAfterDays')}<input aria-label={t('effectiveAfterDays')} value={effectiveAfterDays} onChange={(event) => setEffectiveAfterDays(event.target.value)} /></label>
      <div className="field-with-toggle">
        <label>{t('expiresAfterDays')}<input aria-label={t('expiresAfterDays')} disabled={neverExpires} value={expiresAfterDays} onChange={(event) => setExpiresAfterDays(event.target.value)} /></label>
        {/* 這個開關就是在關掉上面那個欄位，放在它底下才看得出從屬關係。 */}
        <label className="checkbox"><input aria-label={t('neverExpires')} type="checkbox" checked={neverExpires} onChange={(event) => setNeverExpires(event.target.checked)} /> {t('neverExpires')}</label>
      </div>
      <label>{t('expiryNoticeDays')}<input aria-label={t('expiryNoticeDays')} value={expiryNoticeDays} onChange={(event) => setExpiryNoticeDays(event.target.value)} /></label>
    </fieldset>
    <div className="form-actions">
      <button className="button button--primary" disabled={locked || submitting}>{t('saveSettings')}</button>
    </div>
  </form>;
}

function TierSection({ tiers, onRunOperation, recoveries }: { tiers: Tier[]; onRunOperation: RunLoyaltyOperation; recoveries: LoyaltyOperationEntry[] }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [thresholdPoints, setThresholdPoints] = useState('');
  const [multiplier, setMultiplier] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removingTier, setRemovingTier] = useState<Tier | null>(null);
  const recovery = recoveries.find((entry) => entry.operation.kind === 'tier-save') ?? null;
  const locked = recovery !== null;
  useEffect(() => {
    if (recovery?.operation.kind !== 'tier-save') return;
    setName(recovery.operation.draft.name); setThresholdPoints(recovery.operation.draft.thresholdPoints); setMultiplier(recovery.operation.draft.multiplier);
  }, [recovery]);

  const run = async (operation: LoyaltyOperation) => {
    setSubmitting(true); setError(null);
    const result = await onRunOperation(operation);
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
    return result;
  };
  const save = () => {
    const threshold = wholeNumber(thresholdPoints, 0, 10_000_000);
    const multiplierBasisPoints = basisPointsFromMultiplier(multiplier);
    if (!name.trim() || threshold === null || multiplierBasisPoints === null) {
      setError(new Error(t('invalidTier')));
      return;
    }
    const tier = { name: name.trim(), thresholdPoints: threshold, multiplierBasisPoints };
    if (recoveries.some((entry) => entry.operation.scope === `loyalty-tier:${tier.name.toLowerCase()}`)) {
      setError(new Error(t('retryOriginalOperation')));
      return;
    }
    const draft = { name, thresholdPoints, multiplier };
    void run({ area: 'loyalty', scope: `loyalty-tier:${tier.name.toLowerCase()}`, kind: 'tier-save', request: tier, draft, idempotencyKey: crypto.randomUUID() }).then((result) => {
      if (result.state === 'success') { setName(''); setThresholdPoints(''); setMultiplier('1'); }
    });
  };

  return <section className="account-panel" aria-label={t('tiers')}>
    <div className="section-heading"><h2>{t('tiers')}</h2><p>{t('tierRemovalHint')}</p></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <div className="table-wrap"><table className="data-table data-table--fixed loyalty-table">
      <thead>
        <tr>
          <th style={{ width: '34%' }}>{t('tierName')}</th>
          <th style={{ width: '22%' }} className="col-numeric">{t('thresholdPoints')}</th>
          <th style={{ width: '22%' }} className="col-numeric">{t('tierMultiplier')}</th>
          <th style={{ width: '22%' }} className="col-actions">操作</th>
        </tr>
      </thead>
      <tbody>{tiers.map((tier) => (
        <TierRow
          key={tier.name}
          tier={tier}
          submitting={submitting}
          blocked={recoveries.some((entry) => entry.operation.scope === `loyalty-tier:${tier.name.toLowerCase()}`)}
          onRemove={() => setRemovingTier(tier)}
        />
      ))}</tbody>
    </table></div>
    <fieldset className="form-grid form-grid--with-submit" disabled={locked || submitting} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
      <label>{t('tierName')}<input aria-label={t('tierName')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('thresholdPoints')}<input aria-label={t('thresholdPoints')} value={thresholdPoints} onChange={(event) => setThresholdPoints(event.target.value)} /></label>
      <label>{t('tierMultiplier')}<input aria-label={t('tierMultiplier')} value={multiplier} onChange={(event) => setMultiplier(event.target.value)} /></label>
      <button className="button button--primary" type="button" disabled={locked || submitting} onClick={save}>{t('saveTier')}</button>
    </fieldset>
    {removingTier ? <RemoveTierDialog
      tier={removingTier}
      submitting={submitting}
      onClose={() => setRemovingTier(null)}
      onRemove={() => {
        setRemovingTier(null);
        void run({ area: 'loyalty', scope: `loyalty-tier:${removingTier.name.toLowerCase()}`, kind: 'tier-remove', tierName: removingTier.name, request: { name: removingTier.name }, preview: { name: removingTier.name }, idempotencyKey: crypto.randomUUID() });
      }}
    /> : null}
  </section>;
}

/**
 * 移除等級是破壞性動作：一旦刪掉，該門檻內的會員隔天重算就會被判到別的等級。
 * 點移除後由 Dialog 再確認；不用 window.confirm，這樣焦點與 Escape 都由 primitive 處理。
 */
function TierRow({
  tier,
  submitting,
  blocked,
  onRemove,
}: {
  tier: Tier;
  submitting: boolean;
  blocked: boolean;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <tr>
      <td>{tier.name}</td>
      <td className="col-numeric">{tier.thresholdPoints}</td>
      <td className="col-numeric">{toMultiplier(tier.multiplierBasisPoints)}</td>
      <td className="col-actions">
        {tier.thresholdPoints === 0 ? (
          <span className="muted">{t('baseTier')}</span>
        ) : (
          <button
            className="button"
            type="button"
            disabled={submitting || blocked}
            onClick={onRemove}
          >
            <Icon name="trash" /> {t('remove')}
          </button>
        )}
      </td>
    </tr>
  );
}

function RemoveTierDialog({
  tier,
  submitting,
  onClose,
  onRemove,
}: {
  tier: Tier;
  submitting: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent
      className="ui-reason-dialog"
      aria-label={`${t('remove')} ${tier.name}`}
      onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
    >
      <header className="ui-reason-dialog__header">
        <DialogTitle>{t('remove')} {tier.name}</DialogTitle>
        <DialogClose type="button" className="icon-button" aria-label={t('close')}><Icon name="close" /></DialogClose>
      </header>
      <div className="ui-reason-dialog__body">
        <DialogDescription className="ui-reason-dialog__description">{t('tierRemovalHint')}</DialogDescription>
        <footer className="ui-reason-dialog__footer">
          <button className="button" type="button" onClick={onClose}>{t('cancel')}</button>
          <button className="button button--danger" type="button" disabled={submitting} onClick={onRemove}>{t('remove')}</button>
        </footer>
      </div>
    </DialogContent>
  </Dialog>;
}
