import { escapeHtml } from '@storeweave/i18n';
import type { ThemeContext, StorefrontTheme } from '@storeweave/kernel';
import { baseTheme, renderBaseLayout } from '@storeweave/theme-base';
import type { DetailView, EditorView, ListView } from './pages';
import { NOTES_PAGE_SIZE } from './types';

function list(ctx: ThemeContext, view: ListView) {
  const title = view.own ? '我的筆記' : '公開筆記';
  const base = view.own ? '/my-notes' : '/notes';
  const entries = view.items.map(note => `<li><a href="${base}/${escapeHtml(note.id)}">${escapeHtml(note.title)}</a>${view.own ? ` · ${note.status === 'draft' ? '草稿' : '已發布'}` : ''}</li>`).join('');
  return renderBaseLayout(ctx, title, `<h1>${title}</h1>${view.own ? '<p><a href="/my-notes/new">新增筆記</a></p>' : ''}
    ${entries ? `<ul>${entries}</ul>` : '<p>目前沒有筆記。</p>'}
    <nav aria-label="筆記分頁">${view.offset > 0 ? `<a rel="prev" href="${base}?offset=${Math.max(0, view.offset - NOTES_PAGE_SIZE)}">上一頁</a>` : ''}
    ${view.hasMore ? `<a rel="next" href="${base}?offset=${view.offset + NOTES_PAGE_SIZE}">下一頁</a>` : ''}</nav>`);
}
function editor(ctx: ThemeContext, view: EditorView) {
  const note = view.note;
  const title = note ? '編輯筆記' : '新增筆記';
  const fields = `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken ?? '')}">
    <input type="hidden" name="operationId" value="${escapeHtml(view.operationId)}">
    ${note ? `<input type="hidden" name="revision" value="${note.revision}">` : ''}`;
  const path = note ? `/my-notes/${escapeHtml(note.id)}` : '/my-notes';
  const content = note?.status === 'published'
    ? `<p>已發布。請先收回草稿再編輯。</p><p><a href="/notes/${escapeHtml(note.id)}">閱讀公開文章</a></p>
      <form method="post" action="${path}/unpublish">${fields}<button>收回草稿</button></form>`
    : `<form method="post" action="${path}">${fields}
      <label for="title">標題</label><input id="title" name="title" maxlength="160" required value="${escapeHtml(note?.title ?? '')}">
      <label for="body">本文</label><textarea id="body" name="body" maxlength="10000" rows="12" required>${escapeHtml(note?.body ?? '')}</textarea>
      <button>${note ? '儲存草稿' : '建立草稿'}</button></form>
      ${note ? `<p>發布的是已儲存的內容；編輯後請先儲存。</p><form method="post" action="${path}/publish">${fields}<button>發布</button></form>` : ''}`;
  return renderBaseLayout(ctx, title, `<h1>${title}</h1>${content}<p><a href="/my-notes">回到我的筆記</a></p>`);
}
function detail(ctx: ThemeContext, view: DetailView) {
  return renderBaseLayout(ctx, view.note.title, `<article><h1>${escapeHtml(view.note.title)}</h1>
    <div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(view.note.body)}</div></article><p><a href="/notes">所有公開筆記</a></p>`);
}

// The base renderers retain authentication/error pages; no Content module is installed.
export const notesTheme: StorefrontTheme = {
  ...baseTheme,
  renderers: {
    ...baseTheme.renderers,
    'notes.entry.index': list, 'notes.entry.mine': list,
    'notes.entry.new': editor, 'notes.entry.edit': editor, 'notes.entry.view': detail,
  },
};
