/** 載入中提示 */
export function Loading({ label = '載入中…' }: { label?: string }) {
  return <p className="loading">{label}</p>;
}
