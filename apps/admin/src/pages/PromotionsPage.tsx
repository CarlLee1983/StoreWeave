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

/** ISO ⇄ `datetime-local` 的值。datetime-local 沒有時區，顯示與輸入都用瀏覽器本地時間。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface FormState {
  name: string;
  ruleType: RuleType;
  thresholdCents: string;
  discountCents: string;
  percentOff: string;
  maxDiscountCents: string;
  priority: string;
  stackable: boolean;
  startsAt: string;
  endsAt: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  ruleType: 'threshold_fixed_amount',
  thresholdCents: '100000',
  discountCents: '10000',
  percentOff: '10',
  maxDiscountCents: '',
  priority: '0',
  stackable: true,
  startsAt: '',
  endsAt: '',
};

function formStateOf(promotion: Promotion): FormState {
  const rule = promotion.rule;
  return {
    name: promotion.name,
    ruleType: rule.type,
    thresholdCents: 'thresholdCents' in rule ? String(rule.thresholdCents) : EMPTY_FORM.thresholdCents,
    discountCents: rule.type === 'threshold_fixed_amount' ? String(rule.discountCents) : EMPTY_FORM.discountCents,
    percentOff: 'percentOffBasisPoints' in rule ? String(rule.percentOffBasisPoints / 100) : EMPTY_FORM.percentOff,
    maxDiscountCents:
      'maxDiscountCents' in rule && rule.maxDiscountCents !== null && rule.maxDiscountCents !== undefined
        ? String(rule.maxDiscountCents)
        : '',
    priority: String(promotion.priority),
    stackable: promotion.stackable,
    startsAt: toLocalInput(promotion.startsAt),
    endsAt: toLocalInput(promotion.endsAt),
  };
}

export interface PromotionPayload {
  name: string;
  rule: PromotionRule;
  priority: number;
  stackable: boolean;
  startsAt?: string;
  endsAt?: string;
}

/**
 * 經營者填的是百分比與整數分，契約收的是基點——換算與驗證留在這裡，
 * 畫面不出現「基點」這個詞。回傳 Error 表示這份表單不該送出。
 */
function toPayload(form: FormState, t: (key: MessageKey) => string): PromotionPayload | Error {
  const threshold = Number(form.thresholdCents);
  const priority = Number(form.priority);
  const basisPoints = Math.round(Number(form.percentOff) * 100);
  const max = form.maxDiscountCents.trim() === '' ? null : Number(form.maxDiscountCents);
  const invalid = new Error(t('invalidPromotion'));

  if (!form.name.trim() || !Number.isInteger(priority)) return invalid;
  if (form.thresholdCents.trim() === '' && hasThreshold(form.ruleType)) return invalid;
  if (hasThreshold(form.ruleType) && (!Number.isInteger(threshold) || threshold < 0)) return invalid;
  if (max !== null && (!Number.isInteger(max) || max < 0)) return invalid;

  let rule: PromotionRule;
  if (form.ruleType === 'threshold_fixed_amount') {
    const discount = Number(form.discountCents);
    if (!Number.isInteger(discount) || discount <= 0) return invalid;
    rule = { type: form.ruleType, thresholdCents: threshold, discountCents: discount };
  } else {
    if (!Number.isInteger(basisPoints) || basisPoints <= 0 || basisPoints > 10_000) {
      return new Error(t('invalidPercent'));
    }
    rule =
      form.ruleType === 'threshold_percentage'
        ? { type: form.ruleType, thresholdCents: threshold, percentOffBasisPoints: basisPoints, maxDiscountCents: max }
        : { type: form.ruleType, percentOffBasisPoints: basisPoints, maxDiscountCents: max };
  }

  return {
    name: form.name.trim(),
    rule,
    priority,
    stackable: form.stackable,
    startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined,
    endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : undefined,
  };
}

export function PromotionsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const limit = 100;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listPromotions({ status: status || undefined, limit })
      .then((result) => {
        if (cancelled) return;
        setPromotions(result.items);
        setTotal(result.total);
      })
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
        {/* 超出一頁時要說出來，不然第 101 檔活動在後台就是憑空消失 */}
        {total > promotions.length ? <span>{`${promotions.length} / ${total}`}</span> : null}
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
  const [editing, setEditing] = useState(false);
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
    <>
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
          <div className="inline-form">
            <button type="button" onClick={() => setEditing((v) => !v)}>
              {editing ? t('cancel') : t('edit')}
            </button>
            <button type="button" onClick={toggle} disabled={submitting}>
              {promotion.status === 'active' ? t('disable') : t('enable')}
            </button>
          </div>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={7}>
            <EditPromotionForm
              promotion={promotion}
              onSaved={() => {
                setEditing(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function PromotionFields({
  form,
  onChange,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="form-grid">
      <label>{t('promotionName')}
        <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>

      <label>{t('ruleType')}
        <select value={form.ruleType} onChange={(e) => onChange({ ruleType: e.target.value as RuleType })}>
          {RULE_TYPES.map((type) => <option key={type} value={type}>{t(type as MessageKey)}</option>)}
        </select>
      </label>

      {hasThreshold(form.ruleType) ? (
        <label>{t('thresholdCents')}
          <input value={form.thresholdCents} onChange={(e) => onChange({ thresholdCents: e.target.value })} inputMode="numeric" />
        </label>
      ) : null}

      {form.ruleType === 'threshold_fixed_amount' ? (
        <label>{t('discountCents')}
          <input value={form.discountCents} onChange={(e) => onChange({ discountCents: e.target.value })} inputMode="numeric" />
        </label>
      ) : null}

      {hasPercent(form.ruleType) ? (
        <>
          <label>{t('percentOff')}
            <input value={form.percentOff} onChange={(e) => onChange({ percentOff: e.target.value })} inputMode="decimal" />
          </label>
          <label>{t('maxDiscountCents')}
            <input value={form.maxDiscountCents} onChange={(e) => onChange({ maxDiscountCents: e.target.value })} inputMode="numeric" />
          </label>
        </>
      ) : null}

      <label>{t('priority')}
        <input value={form.priority} onChange={(e) => onChange({ priority: e.target.value })} inputMode="numeric" />
      </label>

      <label>{t('startsAt')}
        <input type="datetime-local" value={form.startsAt} onChange={(e) => onChange({ startsAt: e.target.value })} />
      </label>

      <label>{t('endsAt')}
        <input type="datetime-local" value={form.endsAt} onChange={(e) => onChange({ endsAt: e.target.value })} />
      </label>

      <label className="checkbox">
        <input type="checkbox" checked={form.stackable} onChange={(e) => onChange({ stackable: e.target.checked })} />
        {t('stackable')}
      </label>
    </div>
  );
}

function CreatePromotionForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    const payload = toPayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.createPromotion(payload);
      setForm(EMPTY_FORM);
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
      aria-label={t('createPromotion')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{t('createPromotion')}</h3>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <PromotionFields form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
      <button type="submit" disabled={submitting}>{t('createPromotion')}</button>
    </form>
  );
}

function EditPromotionForm({ promotion, onSaved }: { promotion: Promotion; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => formStateOf(promotion));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    const payload = toPayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.updatePromotion(promotion.id, payload);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="panel"
      aria-label={`${t('edit')} ${promotion.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <PromotionFields form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
      <button type="submit" disabled={submitting}>{t('saveChanges')}</button>
    </form>
  );
}
