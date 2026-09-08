import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Article, type ArticleBlock } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { articleKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

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

type ArticleCreateRequest = Parameters<typeof api.createArticle>[0];
type ArticlePatch = Parameters<typeof api.updateArticle>[1];
type ArticleOperation = AdminOperation & (
  | { kind: 'create'; request: ArticleCreateRequest; draft: FormState }
  | { kind: 'edit'; articleId: string; request: ArticlePatch; draft: FormState }
  | { kind: 'publish' | 'unpublish' | 'delete'; articleId: string; request: Record<string, never>; preview: { title: string } }
);
type ArticleOperationEntry = AdminOperationEntry<ArticleOperation>;
type ArticleOperationResult = Awaited<ReturnType<typeof executeAdminOperation<ArticleOperation, Article>>>;
type RunArticleOperation = (operation: ArticleOperation, retryEntry?: ArticleOperationEntry) => Promise<ArticleOperationResult>;
function isArticleOperation(entry: AdminOperationEntry): entry is ArticleOperationEntry {
  return entry.operation.area === 'article' && ['create', 'edit', 'publish', 'unpublish', 'delete'].includes((entry.operation as ArticleOperation).kind);
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
  const queryClient = useQueryClient();
  const operations = useAdminOperations();
  const operationEntries = useAdminOperationEntries().filter(isArticleOperation);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [deletingArticle, setDeletingArticle] = useState<{ article: Article; returnFocus?: HTMLElement | null } | null>(null);
  const limit = 100;

  const input = { kind: (kind || undefined) as Article['kind'] | undefined, status: (status || undefined) as Article['status'] | undefined, limit, offset: 0 };
  const articlesQuery = useQuery({ queryKey: articleKeys.list(input), queryFn: ({ signal }) => api.listArticles(input, signal) });
  const imageKeysQuery = useQuery({ queryKey: articleKeys.imageKeys, queryFn: ({ signal }) => api.contentImageKeys(signal) });
  const articles = articlesQuery.data?.items ?? [];
  const total = articlesQuery.data?.total ?? 0;
  const imageKeys = imageKeysQuery.data?.keys ?? [];
  const reload = () => void articlesQuery.refetch();
  const inspectOperation = (entry: ArticleOperationEntry) => {
    if (entry.operation.kind === 'create') setCreating(true);
    if (entry.operation.kind === 'edit') {
      const operation = entry.operation;
      setEditingArticle(articles.find((article) => article.id === operation.articleId) ?? {
        id: operation.articleId, kind: operation.draft.kind, slug: operation.draft.slug, title: operation.draft.title,
        summary: operation.draft.summary, section: operation.draft.section, body: textToBody(operation.draft.bodyText),
        imageKey: operation.draft.imageKey || null, position: Number(operation.draft.position), status: 'draft', publishedAt: null, createdAt: '', updatedAt: '',
      });
    }
  };
  const commandMutation = useMutation<Article, unknown, ArticleOperation>({ mutationFn: (operation) => {
    switch (operation.kind) {
      case 'create': return api.createArticle(operation.request, operation.idempotencyKey);
      case 'edit': return api.updateArticle(operation.articleId, operation.request, operation.idempotencyKey);
      case 'publish': return api.publishArticle(operation.articleId, operation.idempotencyKey);
      case 'unpublish': return api.unpublishArticle(operation.articleId, operation.idempotencyKey);
      case 'delete': return api.deleteArticle(operation.articleId, operation.idempotencyKey);
    }
  } });
  const runOperation: RunArticleOperation = (operation, retryEntry) => executeAdminOperation(operations, operation,
    (live) => commandMutation.mutateAsync(live),
    () => { void queryClient.invalidateQueries({ queryKey: articleKeys.lists }); return undefined; }, retryEntry);
  const retryOperation = async (entry: ArticleOperationEntry) => {
    const result = await runOperation(entry.operation, entry);
    if (result.state === 'rejected') setOperationError(result.error);
  };

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
      {articlesQuery.isError ? <ErrorBanner error={articlesQuery.error} onRetry={reload} /> : null}
      {operationError ? <ErrorBanner error={operationError} onDismiss={() => setOperationError(null)} /> : null}
      {imageKeysQuery.isError ? <ErrorBanner error={imageKeysQuery.error} onRetry={() => void imageKeysQuery.refetch()} /> : null}
      {operationEntries.map((entry) => <div className="error-banner" role="status" key={entry.operation.idempotencyKey}>
        <span>{entry.operation.kind === 'create' ? `${t('createArticle')}: ${entry.operation.request.title}` : entry.operation.kind === 'edit' ? `${t('edit')}: ${entry.operation.request.title ?? entry.operation.draft.title}` : `${t(entry.operation.kind as 'publish' | 'unpublish' | 'delete')}: ${entry.operation.preview.title}`}</span>
        {entry.error instanceof Error ? <span>{entry.error.message}</span> : null}
        {entry.phase === 'unknown' && (entry.operation.kind === 'create' || entry.operation.kind === 'edit') ? <button type="button" className="button button--quiet" onClick={() => inspectOperation(entry)}>{t('inspectOriginalOperation')}</button> : null}
        {entry.phase === 'unknown' ? <button type="button" className="button button--quiet" onClick={() => void retryOperation(entry)}>{t('retryOriginalOperation')}</button> : null}
      </div>)}

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

      {articlesQuery.isLoading ? (
        <Loading />
      ) : articlesQuery.isSuccess && articles.length === 0 ? (
        <EmptyState icon="file-text" title={t('noArticles')} hint="新增品牌故事、生活誌、最新消息或常見問題，存成草稿後再發布。" />
      ) : articlesQuery.isSuccess ? (
        <div className="table-wrap">
          <table className="data-table data-table--fixed brand-content-table">
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
                  onDelete={(returnFocus) => setDeletingArticle({ article, returnFocus })}
                  onRunOperation={runOperation}
                  blocked={operationEntries.some((entry) => entry.operation.scope === `article:${article.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
        ) : null}

      {creating ? (
        <CreateArticleDrawer
          imageKeys={imageKeys}
          imageKeysError={imageKeysQuery.error}
          onClose={() => setCreating(false)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => entry.operation.scope === 'article:create') ?? null}
        />
      ) : null}

      {editingArticle ? (
        <EditArticleDrawer
          article={editingArticle}
          imageKeys={imageKeys}
          imageKeysError={imageKeysQuery.error}
          onClose={() => setEditingArticle(null)}
          onSaved={() => setEditingArticle(null)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => entry.operation.scope === `article:${editingArticle.id}`) ?? null}
        />
      ) : null}

      {deletingArticle ? (
        <DeleteArticleDialog
          article={deletingArticle.article}
          returnFocus={deletingArticle.returnFocus}
          onClose={() => setDeletingArticle(null)}
          onDeleted={() => setDeletingArticle(null)}
          onRunOperation={runOperation}
          recovery={operationEntries.find((entry) => entry.operation.scope === `article:${deletingArticle.article.id}`) ?? null}
        />
      ) : null}
    </section>
  );
}

function ArticleRow({
  article,
  onEdit,
  onDelete,
  onRunOperation,
  blocked,
}: {
  article: Article;
  onEdit: () => void;
  onDelete: (returnFocus?: HTMLElement | null) => void;
  onRunOperation: RunArticleOperation;
  blocked: boolean;
}) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const togglePublish = async () => {
    setSubmitting(true);
    setError(null);
    const kind = article.status === 'draft' ? 'publish' : 'unpublish';
    const result = await onRunOperation({ area: 'article', scope: `article:${article.id}`, kind, articleId: article.id, request: {}, preview: { title: article.title }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
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
              disabled={submitting || blocked}
              onClick={onEdit}
            >
              <Icon name="pencil" /> {t('edit')}
            </button>
            <RowMenu disabled={submitting || blocked} items={menuItems} />
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
  returnFocus,
  onClose,
  onDeleted,
  onRunOperation,
  recovery,
}: {
  article: Article;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onDeleted: () => void;
  onRunOperation: RunArticleOperation;
  recovery: ArticleOperationEntry | null;
}) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = recovery !== null;

  const returnFocusRef = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  const remove = async () => {
    if (locked) return;
    setSubmitting(true);
    setError(null);
    const result = await onRunOperation({ area: 'article', scope: `article:${article.id}`, kind: 'delete', articleId: article.id, request: {}, preview: { title: article.title }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'success') onDeleted();
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };
  const retry = async () => {
    if (!recovery) return;
    const result = await onRunOperation(recovery.operation, recovery);
    if (result.state === 'success') onDeleted();
    if (result.state === 'rejected') setError(result.error);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-reason-dialog"
        aria-label={t('deleteArticleTitle')}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="ui-reason-dialog__header">
          <DialogTitle>{t('deleteArticleTitle')}</DialogTitle>
          <DialogClose type="button" className="icon-button" aria-label={t('close')}>
            <Icon name="close" />
          </DialogClose>
        </header>
        <div className="ui-reason-dialog__body">
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          <DialogDescription className="ui-reason-dialog__description">{article.title} — {t('deleteArticleDesc')}</DialogDescription>
          <footer className="ui-reason-dialog__footer">
            <button className="button" type="button" onClick={onClose}>{t('cancel')}</button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--danger" type="button" disabled={locked || submitting} onClick={() => void remove()}>
              {t('delete')}
            </button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ArticleFields({
  form,
  onChange,
  kindLocked,
  imageKeys,
  imageKeysError,
  slugRef,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  kindLocked: boolean;
  imageKeys: string[];
  imageKeysError?: unknown;
  slugRef?: React.RefObject<HTMLInputElement>;
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
        <input ref={slugRef} value={form.slug} onChange={(e) => onChange({ slug: e.target.value })} />
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
  onRunOperation,
  recovery,
}: {
  imageKeys: string[];
  imageKeysError: unknown;
  onClose: () => void;
  onRunOperation: RunArticleOperation;
  recovery: ArticleOperationEntry | null;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const slugRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = recovery !== null;
  useEffect(() => { if (recovery?.operation.kind === 'create') setForm(recovery.operation.draft); }, [recovery]);
  useEffect(() => { if (locked) cancelRef.current?.focus(); }, [locked]);

  const submit = async () => {
    const payload = articlePayload(form, t);
    if (payload instanceof Error) {
      setError(payload);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onRunOperation({ area: 'article', scope: 'article:create', kind: 'create', request: payload, draft: { ...form }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'success') onClose();
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };
  const retry = async () => {
    if (!recovery) return;
    const result = await onRunOperation(recovery.operation, recovery);
    if (result.state === 'rejected') setError(result.error);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-product-sheet"
        aria-label={t('createArticle')}
        onOpenAutoFocus={(event) => { event.preventDefault(); (locked ? cancelRef.current : slugRef.current)?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('createArticle')}</DialogTitle>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
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

          <fieldset className="drawer-form-body" disabled={locked || submitting} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <ArticleFields
              form={form}
              kindLocked={false}
              imageKeys={imageKeys}
              imageKeysError={imageKeysError}
              slugRef={slugRef}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            />
          </fieldset>

          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={locked || submitting}>
              {t('createArticle')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditArticleDrawer({
  article,
  imageKeys,
  imageKeysError,
  onClose,
  onSaved,
  onRunOperation,
  recovery,
}: {
  article: Article;
  imageKeys: string[];
  imageKeysError: unknown;
  onClose: () => void;
  onSaved: () => void;
  onRunOperation: RunArticleOperation;
  recovery: ArticleOperationEntry | null;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => formStateOf(article));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const slugRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const locked = recovery !== null;
  useEffect(() => { if (recovery?.operation.kind === 'edit') setForm(recovery.operation.draft); }, [recovery]);
  useEffect(() => { if (locked) cancelRef.current?.focus(); }, [locked]);

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
    const result = await onRunOperation({ area: 'article', scope: `article:${article.id}`, kind: 'edit', articleId: article.id, request: patch, draft: { ...form }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'success') onSaved();
    if (result.state === 'rejected') setError(result.error);
    setSubmitting(false);
  };
  const retry = async () => {
    if (!recovery) return;
    const result = await onRunOperation(recovery.operation, recovery);
    if (result.state === 'rejected') setError(result.error);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="ui-product-sheet"
        aria-label={`${t('edit')} ${article.title}`}
        onOpenAutoFocus={(event) => { event.preventDefault(); (locked ? cancelRef.current : slugRef.current)?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
      >
        <header className="product-drawer-header">
          <div>
            <DialogTitle>{t('edit')}</DialogTitle>
            <p className="product-drawer-sku">{article.title}</p>
          </div>
          <DialogClose type="button" className="icon-button" aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </DialogClose>
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

          <fieldset className="drawer-form-body" disabled={locked || submitting} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
            <ArticleFields
              form={form}
              kindLocked
              imageKeys={imageKeys}
              imageKeysError={imageKeysError}
              slugRef={slugRef}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            />
          </fieldset>

          <footer className="product-drawer-footer">
            <button ref={cancelRef} className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            {recovery?.phase === 'unknown' ? <button className="button button--quiet" type="button" onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}
            <button className="button button--primary" disabled={locked || submitting}>
              {t('saveChanges')}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
