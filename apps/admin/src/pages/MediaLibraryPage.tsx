import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MediaAsset } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { Loading } from '../components/Loading';
import { Icon } from '../components/Icon';
import { CopyButton } from '../components/CopyButton';
import { mediaKeys } from '../query';

const PAGE_SIZE = 50;

/** B10 owns the library only. Content and Theme decide how a ready asset is referenced in later tickets. */
export function MediaLibraryPage() {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<MediaAsset | null>(null);
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  const [page, setPage] = useState(1);
  const listInput = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
  const mediaQuery = useQuery({ queryKey: mediaKeys.list(listInput), queryFn: ({ signal }) => api.listMedia(listInput, signal),
    refetchInterval: (query) => query.state.data?.items.some((asset) => asset.status === 'pending' || asset.status === 'processing') ? 3_000 : false });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: mediaKeys.all });
  const upload = useMutation({ mutationFn: api.uploadMedia, onSuccess: refresh, onError: setError });
  const updateAlt = useMutation({ mutationFn: ({ id, altText }: { id: string; altText: string }) => api.updateMediaAltText(id, altText), onSuccess: () => { setEditing(null); refresh(); }, onError: setError });
  const retry = useMutation({ mutationFn: api.retryMedia, onSuccess: refresh, onError: setError });
  const remove = useMutation({ mutationFn: api.deleteMedia, onSuccess: refresh, onError: setError });
  const uploadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) upload.mutate(file);
    event.target.value = '';
  };

  return <section>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {mediaQuery.isError ? <ErrorBanner error={mediaQuery.error} onRetry={() => void mediaQuery.refetch()} /> : null}
    <div className="toolbar">
      <label className="button button--primary" aria-busy={upload.isPending}>
        <Icon name="upload" /> {upload.isPending ? t('uploadingMedia') : t('uploadMedia')}
        <input aria-label={t('uploadMedia')} type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={upload.isPending} onChange={uploadFile} />
      </label>
      <span>{t('mediaUploadHint')}</span>
    </div>
    {mediaQuery.isLoading ? <Loading /> : null}
    {mediaQuery.isSuccess && mediaQuery.data.items.length === 0 ? <EmptyState icon="upload" title={t('noMedia')} hint={t('mediaUploadHint')} /> : null}
    {selected ? <div className="form-panel" role="status"><span>{t('selectedMedia')}: <code className="mono">{selected.id}</code> <CopyButton text={selected.id} label={t('mediaAssetId')} /></span><button className="button button--quiet" type="button" onClick={() => setSelected(null)}>{t('cancel')}</button></div> : null}
    {mediaQuery.isSuccess && mediaQuery.data.items.length > 0 ? <div className="table-wrap"><table className="data-table data-table--fixed">
      <thead><tr><th>{t('altText')}</th><th>{t('mediaDimensions')}</th><th>{t('status')}</th><th>{t('createdAt')}</th><th className="col-actions">{t('actions')}</th></tr></thead>
      <tbody>{mediaQuery.data.items.map((asset) => <tr key={asset.id}>
        <td><div>{asset.altText || <span className="muted">{t('noAltText')}</span>}</div><small className="mono">{asset.id} <CopyButton text={asset.id} label={t('mediaAssetId')} /></small>{asset.processingError ? <small className="error-text">{asset.processingError}</small> : null}</td>
        <td className="mono">{asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—'}</td>
        <td>{asset.status === 'ready' ? t('mediaReady') : asset.status === 'processing' ? t('mediaProcessing') : asset.status === 'pending' ? t('pending') : t('failed')}</td><td className="mono">{formatDateTime(asset.createdAt)}</td>
        <td className="col-actions"><div className="toolbar">
          {asset.status === 'ready' ? <button className="button button--quiet" type="button" onClick={() => setSelected(asset)}>{t('selectMedia')}</button> : null}
          <button className="button button--quiet" type="button" disabled={updateAlt.isPending || remove.isPending} onClick={() => setEditing(asset)}><Icon name="pencil" /> {t('edit')}</button>
          {asset.status === 'failed' ? <button className="button button--quiet" type="button" disabled={retry.isPending || remove.isPending} onClick={() => retry.mutate(asset.id)}><Icon name="refresh" /> {t('retryMedia')}</button> : null}
          <button className="button button--quiet" type="button" disabled={remove.isPending} onClick={() => remove.mutate(asset.id)}><Icon name="trash" /> {t('delete')}</button>
        </div></td>
      </tr>)}</tbody>
    </table>{mediaQuery.data.total > PAGE_SIZE ? <MediaPagination page={page} total={mediaQuery.data.total} onPageChange={setPage} /> : null}</div> : null}
    {editing ? <AltTextForm asset={editing} submitting={updateAlt.isPending} onCancel={() => setEditing(null)} onSubmit={(altText) => updateAlt.mutate({ id: editing.id, altText })} /> : null}
  </section>;
}

function MediaPagination({ page, total, onPageChange }: { page: number; total: number; onPageChange: (page: number) => void }) {
  const { t } = useI18n();
  const totalPages = Math.ceil(total / PAGE_SIZE);
  return <div className="pagination-bar">
    <div className="pagination-bar__info"><span>{t('paginationInfo', { start: (page - 1) * PAGE_SIZE + 1, end: Math.min(page * PAGE_SIZE, total), total })}</span></div>
    <div className="pagination-bar__controls">
      <button className="button button--quiet pagination-btn" type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><Icon name="arrow-left" /> {t('previousPage')}</button>
      <span className="pagination-page-badge">{t('paginationPage', { page, total: totalPages })}</span>
      <button className="button button--quiet pagination-btn" type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{t('nextPage')} <Icon name="arrow-right" /></button>
    </div>
  </div>;
}

function AltTextForm({ asset, submitting, onCancel, onSubmit }: { asset: MediaAsset; submitting: boolean; onCancel: () => void; onSubmit: (altText: string) => void }) {
  const { t } = useI18n();
  const [altText, setAltText] = useState(asset.altText);
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(altText); };
  return <form className="form-panel" aria-label={t('editMediaAltText')} onSubmit={submit}>
    <div className="form-field"><label htmlFor="media-alt-text"><span className="field-label-text">{t('altText')}</span></label>
      <input id="media-alt-text" maxLength={500} value={altText} onChange={(event) => setAltText(event.target.value)} autoFocus />
    </div>
    <footer className="toolbar"><button className="button" type="button" onClick={onCancel}>{t('cancel')}</button><button className="button button--primary" type="submit" disabled={submitting}>{t('save')}</button></footer>
  </form>;
}
