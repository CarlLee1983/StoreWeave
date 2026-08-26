import { useEffect, useState } from 'react';
import { api, type Article, type ArticleBlock } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';

const KINDS = ['story', 'journal', 'news', 'faq'] as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * body 是一個區塊陣列，每一塊有選填的標題與必填的內文。Admin 用單一 textarea 編輯，
 * 以空行分段；一段若以 `## ` 開頭，該行是這個區塊的標題，其餘留白。
 */
export function bodyToText(blocks: ArticleBlock[]): string {
  return blocks
    .map((block) => (block.heading ? `## ${block.heading}\n${block.text}` : block.text))
    .join('\n\n');
}

export function textToBody(text: string): ArticleBlock[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      if (lines[0].startsWith('## ')) {
        return { heading: lines[0].slice(3).trim(), text: lines.slice(1).join('\n').trim() };
      }
      return { heading: null, text: chunk };
    });
}

interface FormState {
  kind: Article['kind'];
  slug: string;
  title: string;
  summary: string;
  section: string;
  bodyText: string;
  imageKey: string;
  position: string;
}

const EMPTY_FORM: FormState = {
  kind: 'news',
  slug: '',
  title: '',
  summary: '',
  section: '',
  bodyText: '',
  imageKey: '',
  position: '0',
};

function formStateOf(article: Article): FormState {
  return {
    kind: article.kind,
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    section: article.section,
    bodyText: bodyToText(article.body),
    imageKey: article.imageKey ?? '',
    position: String(article.position),
  };
}

export interface ArticlePayload {
  kind: Article['kind'];
  slug: string;
  title: string;
  summary: string;
  section: string;
  body: ArticleBlock[];
  imageKey: string | null;
  position: number;
}

/** 驗證用純函式：合法回 Payload，不合法回一句能讀的錯誤——不丟資料庫例外給使用者看。 */
export function articlePayload(form: FormState, t: (key: MessageKey) => string): ArticlePayload | Error {
  const invalid = new Error(t('invalidArticle'));
  const slug = form.slug.trim();
  const title = form.title.trim();
  const position = Number(form.position);
  const body = textToBody(form.bodyText);

  if (!SLUG_PATTERN.test(slug)) return invalid;
  if (!title) return invalid;
  if (!Number.isInteger(position) || position < 0) return invalid;
  if (body.length === 0 || body.some((block) => !block.text)) return invalid;

  return {
    kind: form.kind,
    slug,
    title,
    summary: form.summary.trim(),
    section: form.section.trim(),
    body,
    imageKey: form.imageKey || null,
    position,
  };
}

export function BrandContentPage() {
  const { t } = useI18n();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [articles, setArticles] = useState<Article[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [deletingArticle, setDeletingArticle] = useState<Article | null>(null);
  const [imageKeys, setImageKeys] = useState<string[]>([]);
  const [imageKeysError, setImageKeysError] = useState<unknown>(null);
  const limit = 100;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listArticles({ kind: (kind || undefined) as Article['kind'] | undefined, status: (status || undefined) as Article['status'] | undefined, limit })
      .then((result) => {
        if (cancelled) return;
        setArticles(result.items);
        setTotal(result.total);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [kind, status, reloadKey]);

  // 哪些圖存在是 Theme 的事（ADR 0034），這裡只問 API，不寫死清單。
  useEffect(() => {
    let cancelled = false;
    api.contentImageKeys()
      .then((result) => !cancelled && setImageKeys(result.keys))
      .catch((err) => !cancelled && setImageKeysError(err));
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = () => setReloadKey((k) => k + 1);

  // 頁首那顆「+ 新增內容」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開抽屜，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => {
      event.preventDefault();
      setCreating(true);
    };
    window.addEventListener('admin:action:create-article', openCreate);
    return () => window.removeEventListener('admin:action:create-article', openCreate);
  }, []);

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      <div className="toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('kind')}>
          <option value="">{t('allKinds')}</option>
          {KINDS.map((k) => <option key={k} value={k}>{t(k)}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="draft">{t('draft')}</option>
          <option value="published">{t('published')}</option>
        </select>
        {total > articles.length ? <span>{`${articles.length} / ${total}`}</span> : null}
      </div>

      {loading ? (
        <Loading />
      ) : articles.length === 0 ? (
        <EmptyState icon="file-text" title={t('noArticles')} hint="新增品牌故事、生活誌、最新消息或常見問題，存成草稿後再發布。" />
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table--fixed">
            <thead>
              <tr>
                <th style={{ width: '14%' }}>{t('kind')}</th>
                <th style={{ width: '28%' }}>{t('articleTitle')}</th>
                <th style={{ width: '20%' }}>{t('slug')}</th>
                <th style={{ width: '10%' }} className="col-numeric">{t('position')}</th>
                <th style={{ width: '14%' }}>{t('status')}</th>
                <th style={{ width: '14%' }} className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {articles.map((article) => (
                <ArticleRow
                  key={article.id}
                  article={article}
                  onEdit={() => setEditingArticle(article)}
                  onDelete={() => setDeletingArticle(article)}
                  onChanged={reload}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateArticleDrawer
          imageKeys={imageKeys}
          imageKeysError={imageKeysError}
          onClose={() => setCreating(false)}
          onCreated={reload}
        />
      ) : null}

      {editingArticle ? (
        <EditArticleDrawer
          article={editingArticle}
          imageKeys={imageKeys}
          imageKeysError={imageKeysError}
          onClose={() => setEditingArticle(null)}
          onSaved={() => {
            reload();
            setEditingArticle(null);
          }}
        />
      ) : null}

      {deletingArticle ? (
        <DeleteArticleDialog
          article={deletingArticle}
          onClose={() => setDeletingArticle(null)}
          onDeleted={() => {
            reload();
            setDeletingArticle(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ArticleRow({
  article,
  onEdit,
  onDelete,
  onChanged,
}: {
  article: Article;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const togglePublish = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (article.status === 'draft') {
        await api.publishArticle(article.id);
      } else {
        await api.unpublishArticle(article.id);
      }
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const menuItems: RowMenuItem[] = [
    article.status === 'draft'
      ? { key: 'publish', label: t('publish'), icon: 'upload', onSelect: () => void togglePublish() }
      : { key: 'unpublish', label: t('unpublish'), icon: 'eye-off', onSelect: () => void togglePublish() },
    { key: 'delete', label: t('delete'), icon: 'trash', danger: true, onSelect: onDelete },
  ];

  return (
    <tr>
      <td>{t(article.kind)}</td>
      <td>{article.title}</td>
      <td className="mono">{article.slug}</td>
      <td className="mono col-numeric">{article.position}</td>
      <td>
        <StatusBadge
          value={article.status}
          label={article.status === 'draft' ? t('draft') : t('published')}
        />
      </td>
      <td>
        <div className="product-actions-cell">
          <div className="product-actions-row">
            <button
              className="button button--quiet edit-btn"
              type="button"
              disabled={submitting}
              onClick={onEdit}
            >
              <Icon name="pencil" /> {t('edit')}
            </button>
            <RowMenu disabled={submitting} items={menuItems} />
          </div>
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * 刪除是破壞性動作，不用 window.prompt / window.confirm——那會凍結整個分頁，
 * 而且沒有機會在原地顯示送出失敗的錯誤。這裡不收理由：刪除只有 id 一個參數，
 * 收了理由也沒有地方送。抽屜掛在頁面層級而不是表格列裡，`<tr>` 底下不能塞 `<div>`。
 */
function DeleteArticleDialog({
  article,
  onClose,
  onDeleted,
}: {
  article: Article;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEscapeKey(onClose);

  const remove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteArticle(article.id);
      onDeleted();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="reason-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('deleteArticleTitle')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="reason-dialog-header">
          <h3>{t('deleteArticleTitle')}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')}>
            <Icon name="close" />
          </button>
        </header>
        <div className="reason-dialog-body">
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          <p className="reason-dialog-desc">{article.title} — {t('deleteArticleDesc')}</p>
          <footer className="reason-dialog-footer">
            <button className="button" type="button" onClick={onClose}>{t('cancel')}</button>
            <button className="button button--danger" type="button" disabled={submitting} onClick={() => void remove()}>
              {t('delete')}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function ArticleFields({
  form,
  onChange,
  kindLocked,
  imageKeys,
  imageKeysError,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  kindLocked: boolean;
  imageKeys: string[];
  imageKeysError?: unknown;
}) {
  const { t } = useI18n();
  return (
    <div className="form-grid">
      <label>{t('kind')}
        <select
          value={form.kind}
          disabled={kindLocked}
          onChange={(e) => onChange({ kind: e.target.value as Article['kind'] })}
        >
          {KINDS.map((k) => <option key={k} value={k}>{t(k)}</option>)}
        </select>
      </label>

      <label>{t('slug')}
        <input value={form.slug} onChange={(e) => onChange({ slug: e.target.value })} />
      </label>

      <label>{t('articleTitle')}
        <input value={form.title} onChange={(e) => onChange({ title: e.target.value })} />
      </label>

      <label>{t('summary')}
        <input value={form.summary} onChange={(e) => onChange({ summary: e.target.value })} />
      </label>

      <label>{t('section')}
        <input value={form.section} onChange={(e) => onChange({ section: e.target.value })} />
      </label>

      <label>{t('image')}
        <select value={form.imageKey} onChange={(e) => onChange({ imageKey: e.target.value })}>
          <option value="">{t('noImageOption')}</option>
          {imageKeys.map((key) => <option key={key} value={key}>{key}</option>)}
        </select>
        {imageKeysError ? <p className="field-hint">{t('imageKeysLoadError')}</p> : null}
      </label>

      <label>{t('position')}
        <input value={form.position} onChange={(e) => onChange({ position: e.target.value })} inputMode="numeric" />
      </label>

      <label className="form-field--full">{t('articleBody')}
        <textarea
          aria-label={t('articleBody')}
          rows={10}
          value={form.bodyText}
          onChange={(e) => onChange({ bodyText: e.target.value })}
        />
        <p className="field-hint">{t('articleBodyHint')}</p>
      </label>
    </div>
  );
}

function CreateArticleDrawer({
  imageKeys,
  imageKeysError,
  onClose,
  onCreated,
}: {
  imageKeys: string[];
  imageKeysError: unknown;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEscapeKey(onClose);

  const submit = async () => {
    const payload = articlePayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.createArticle(payload);
      onCreated();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="payload-drawer product-edit-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('createArticle')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="product-drawer-header">
          <div>
            <h2>{t('createArticle')}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </button>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('createArticle')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <div className="drawer-form-body">
            <ArticleFields
              form={form}
              kindLocked={false}
              imageKeys={imageKeys}
              imageKeysError={imageKeysError}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            />
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {t('createArticle')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function EditArticleDrawer({
  article,
  imageKeys,
  imageKeysError,
  onClose,
  onSaved,
}: {
  article: Article;
  imageKeys: string[];
  imageKeysError: unknown;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => formStateOf(article));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEscapeKey(onClose);

  const submit = async () => {
    const payload = articlePayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    // kind 建立後不可改，抽屜裡的下拉是鎖住的展示，送出時不帶這個欄位。
    // 只送真的改過的欄位：全欄位送出會讓「沒改任何東西按儲存」也寫一筆稽核。
    const { kind: _kind, ...payloadNoKind } = payload;
    const patch: Partial<typeof payloadNoKind> = {};
    if (payloadNoKind.slug !== article.slug) patch.slug = payloadNoKind.slug;
    if (payloadNoKind.title !== article.title) patch.title = payloadNoKind.title;
    if (payloadNoKind.summary !== article.summary) patch.summary = payloadNoKind.summary;
    if (payloadNoKind.section !== article.section) patch.section = payloadNoKind.section;
    if (JSON.stringify(payloadNoKind.body) !== JSON.stringify(article.body)) patch.body = payloadNoKind.body;
    if (payloadNoKind.imageKey !== (article.imageKey ?? null)) patch.imageKey = payloadNoKind.imageKey;
    if (payloadNoKind.position !== article.position) patch.position = payloadNoKind.position;
    if (Object.keys(patch).length === 0) {
      setError(new Error(t('noFieldsChanged')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.updateArticle(article.id, patch);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="payload-drawer product-edit-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('edit')} ${article.title}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="product-drawer-header">
          <div>
            <h2>{t('edit')}</h2>
            <p className="product-drawer-sku">{article.title}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </button>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={`${t('edit')} ${article.title}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <div className="drawer-form-body">
            <ArticleFields
              form={form}
              kindLocked
              imageKeys={imageKeys}
              imageKeysError={imageKeysError}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            />
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {t('saveChanges')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
