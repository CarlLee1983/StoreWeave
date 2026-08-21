import { useI18n } from '../i18n';
/** 載入中提示 */
export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return <p className="loading">{label ?? t('loading')}</p>;
}
