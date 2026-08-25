import { useEffect, useState } from 'react';
import { api, type RewardSettings, type Tier } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

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

/** 上下界跟著 dto.ts 的 zod 範圍走；少一道，後端就會用英文 zod 訊息回一個 400。 */
function wholeNumber(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : null;
}

export function LoyaltyPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<RewardSettings | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([api.getRewardSettings(), api.listTiers()])
      .then(([loadedSettings, loadedTiers]) => {
        if (cancelled) return;
        setSettings(loadedSettings);
        setTiers(loadedTiers.items);
      })
      .catch((reason) => !cancelled && setError(reason))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [reloadKey]);

  const reload = () => setReloadKey((value) => value + 1);
  if (loading && !settings) return <Loading />;
  return <section>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <p className="muted">{t('loyaltyNoRetroHint')}</p>
    {settings ? <RewardSettingsForm settings={settings} onSaved={reload} /> : null}
    <TierSection tiers={tiers} onChanged={reload} />
  </section>;
}

function RewardSettingsForm({ settings, onSaved }: { settings: RewardSettings; onSaved: () => void }) {
  const { t } = useI18n();
  const [accrual, setAccrual] = useState(() => toPercent(settings.accrualBasisPoints));
  const [effectiveAfterDays, setEffectiveAfterDays] = useState(String(settings.effectiveAfterDays));
  const [neverExpires, setNeverExpires] = useState(settings.expiresAfterDays === null);
  const [expiresAfterDays, setExpiresAfterDays] = useState(settings.expiresAfterDays === null ? '' : String(settings.expiresAfterDays));
  const [expiryNoticeDays, setExpiryNoticeDays] = useState(String(settings.expiryNoticeDays));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

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
    try { await api.updateRewardSettings(patch); onSaved(); }
    catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };

  return <form className="form-panel" aria-label={t('rewardSettings')} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h2>{t('rewardSettings')}</h2>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <div className="inline-form">
      <label>{t('accrualPercent')}<input aria-label={t('accrualPercent')} value={accrual} onChange={(event) => setAccrual(event.target.value)} /></label>
      <label>{t('effectiveAfterDays')}<input aria-label={t('effectiveAfterDays')} value={effectiveAfterDays} onChange={(event) => setEffectiveAfterDays(event.target.value)} /></label>
      <label>{t('expiresAfterDays')}<input aria-label={t('expiresAfterDays')} disabled={neverExpires} value={expiresAfterDays} onChange={(event) => setExpiresAfterDays(event.target.value)} /></label>
      <label><input aria-label={t('neverExpires')} type="checkbox" checked={neverExpires} onChange={(event) => setNeverExpires(event.target.checked)} /> {t('neverExpires')}</label>
      <label>{t('expiryNoticeDays')}<input aria-label={t('expiryNoticeDays')} value={expiryNoticeDays} onChange={(event) => setExpiryNoticeDays(event.target.value)} /></label>
    </div>
    <button className="button button--primary" disabled={submitting}>{t('saveSettings')}</button>
  </form>;
}

function TierSection({ tiers, onChanged }: { tiers: Tier[]; onChanged: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [thresholdPoints, setThresholdPoints] = useState('');
  const [multiplier, setMultiplier] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (action: () => Promise<unknown>) => {
    setSubmitting(true); setError(null);
    try { await action(); onChanged(); } catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };
  const save = () => {
    const threshold = wholeNumber(thresholdPoints, 0, 10_000_000);
    const multiplierBasisPoints = basisPointsFromMultiplier(multiplier);
    if (!name.trim() || threshold === null || multiplierBasisPoints === null) {
      setError(new Error(t('invalidTier')));
      return;
    }
    void run(async () => {
      await api.saveTier({ name: name.trim(), thresholdPoints: threshold, multiplierBasisPoints });
      setName(''); setThresholdPoints(''); setMultiplier('1');
    });
  };

  return <section className="account-panel" aria-label={t('tiers')}>
    <div className="section-heading"><h2>{t('tiers')}</h2><p>{t('tierRemovalHint')}</p></div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <div className="table-wrap"><table className="data-table">
      <thead><tr><th>{t('tierName')}</th><th>{t('thresholdPoints')}</th><th>{t('tierMultiplier')}</th><th /></tr></thead>
      <tbody>{tiers.map((tier) => <tr key={tier.name}>
        <td>{tier.name}</td>
        <td className="mono">{tier.thresholdPoints}</td>
        <td className="mono">{toMultiplier(tier.multiplierBasisPoints)}</td>
        <td>{tier.thresholdPoints === 0
          ? <span className="muted">{t('baseTier')}</span>
          : <button className="button" type="button" disabled={submitting} onClick={() => void run(() => api.removeTier(tier.name))}>{t('remove')}</button>}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="inline-form">
      <label>{t('tierName')}<input aria-label={t('tierName')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('thresholdPoints')}<input aria-label={t('thresholdPoints')} value={thresholdPoints} onChange={(event) => setThresholdPoints(event.target.value)} /></label>
      <label>{t('tierMultiplier')}<input aria-label={t('tierMultiplier')} value={multiplier} onChange={(event) => setMultiplier(event.target.value)} /></label>
      <button className="button button--primary" type="button" disabled={submitting} onClick={save}>{t('saveTier')}</button>
    </div>
  </section>;
}
