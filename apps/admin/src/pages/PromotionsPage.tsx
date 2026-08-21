import { useEffect, useState } from 'react';
import { api, type Promotion, type PromotionRule } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

/** 規則型別在編譯期已知，每一種有自己的表單欄位——折扣設定需要客製 UI，不做 schema 驅動的動態表單。 */
const RULE_TYPES = ['threshold_fixed_amount', 'threshold_percentage', 'order_percentage'] as const;
type RuleType = (typeof RULE_TYPES)[number];

const hasThreshold = (type: RuleType) => type !== 'order_percentage';
const hasPercent = (type: RuleType) => type !== 'threshold_fixed_amount';

export function PromotionsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listPromotions({ status: status || undefined, limit: 100 })
      .then((result) => !cancelled && setPromotions(result.items))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('active')}</option>
          <option value="disabled">{t('disabled')}</option>
        </select>
      </div>

      <CreatePromotionForm onCreated={reload} />

      {loading ? (
        <Loading />
      ) : promotions.length === 0 ? (
        <p>{t('noPromotions')}</p>
      ) : (
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>{t('promotionName')}</th><th>{t('ruleType')}</th><th>{t('period')}</th>
              <th>{t('priority')}</th><th>{t('stackable')}</th><th>{t('status')}</th><th />
            </tr>
          </thead>
          <tbody>
            {promotions.map((promotion) => (
              <PromotionRow key={promotion.id} promotion={promotion} onChanged={reload} />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function PromotionRow({ promotion, onChanged }: { promotion: Promotion; onChanged: () => void }) {
  const { t, formatDateTime } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextStatus = promotion.status === 'active' ? 'disabled' : 'active';

  const toggle = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.setPromotionStatus(promotion.id, nextStatus);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <tr>
      <td>{promotion.name}</td>
      <td>{t(promotion.rule.type as MessageKey)}</td>
      <td className="mono">
        {promotion.startsAt ? formatDateTime(promotion.startsAt) : '—'} → {promotion.endsAt ? formatDateTime(promotion.endsAt) : '—'}
      </td>
      <td className="mono">{promotion.priority}</td>
      <td>{promotion.stackable ? '✓' : '—'}</td>
      <td><StatusBadge value={promotion.status} /></td>
      <td>
        <button type="button" onClick={toggle} disabled={submitting}>
          {promotion.status === 'active' ? t('disable') : t('enable')}
        </button>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

function CreatePromotionForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState<RuleType>('threshold_fixed_amount');
  const [thresholdCents, setThresholdCents] = useState('100000');
  const [discountCents, setDiscountCents] = useState('10000');
  const [percentOff, setPercentOff] = useState('10');
  const [maxDiscountCents, setMaxDiscountCents] = useState('');
  const [priority, setPriority] = useState('0');
  const [stackable, setStackable] = useState(true);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  /** 經營者填的是百分比，契約收的是基點——換算留在這裡，畫面不出現「基點」這個詞。 */
  const buildRule = (): PromotionRule | Error => {
    const threshold = Number(thresholdCents);
    const percent = Number(percentOff);
    const basisPoints = Math.round(percent * 100);
    const max = maxDiscountCents.trim() === '' ? null : Number(maxDiscountCents);

    if (hasThreshold(ruleType) && (!Number.isInteger(threshold) || threshold < 0)) {
      return new Error(t('invalidPromotion'));
    }
    if (max !== null && (!Number.isInteger(max) || max < 0)) return new Error(t('invalidPromotion'));

    if (ruleType === 'threshold_fixed_amount') {
      const discount = Number(discountCents);
      if (!Number.isInteger(discount) || discount <= 0) return new Error(t('invalidPromotion'));
      return { type: ruleType, thresholdCents: threshold, discountCents: discount };
    }
    if (!Number.isInteger(basisPoints) || basisPoints <= 0 || basisPoints > 10_000) {
      return new Error(t('invalidPercent'));
    }
    return ruleType === 'threshold_percentage'
      ? { type: ruleType, thresholdCents: threshold, percentOffBasisPoints: basisPoints, maxDiscountCents: max }
      : { type: ruleType, percentOffBasisPoints: basisPoints, maxDiscountCents: max };
  };

  const submit = async () => {
    const priorityNum = Number(priority);
    const rule = buildRule();
    if (!name.trim() || !Number.isInteger(priorityNum)) {
      setError(new Error(t('invalidPromotion')));
      return;
    }
    if (rule instanceof Error) {
      setError(rule);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.createPromotion({
        name: name.trim(),
        rule,
        priority: priorityNum,
        stackable,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      });
      setName('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      id="create-promotion"
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{t('createPromotion')}</h3>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      <div className="form-grid">
        <label>{t('promotionName')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label>{t('ruleType')}
          <select value={ruleType} onChange={(e) => setRuleType(e.target.value as RuleType)}>
            {RULE_TYPES.map((type) => <option key={type} value={type}>{t(type as MessageKey)}</option>)}
          </select>
        </label>

        {hasThreshold(ruleType) ? (
          <label>{t('thresholdCents')}
            <input value={thresholdCents} onChange={(e) => setThresholdCents(e.target.value)} inputMode="numeric" />
          </label>
        ) : null}

        {ruleType === 'threshold_fixed_amount' ? (
          <label>{t('discountCents')}
            <input value={discountCents} onChange={(e) => setDiscountCents(e.target.value)} inputMode="numeric" />
          </label>
        ) : null}

        {hasPercent(ruleType) ? (
          <>
            <label>{t('percentOff')}
              <input value={percentOff} onChange={(e) => setPercentOff(e.target.value)} inputMode="decimal" />
            </label>
            <label>{t('maxDiscountCents')}
              <input value={maxDiscountCents} onChange={(e) => setMaxDiscountCents(e.target.value)} inputMode="numeric" />
            </label>
          </>
        ) : null}

        <label>{t('priority')}
          <input value={priority} onChange={(e) => setPriority(e.target.value)} inputMode="numeric" />
        </label>

        <label>{t('startsAt')}
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>

        <label>{t('endsAt')}
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
          {t('stackable')}
        </label>
      </div>

      <button type="submit" disabled={submitting}>{t('createPromotion')}</button>
    </form>
  );
}
