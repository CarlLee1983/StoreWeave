import { escapeHtml } from '@storeweave/i18n';
import type { PageRenderer, ThemeContext } from '@storeweave/kernel';
import type { FileRequestDetailView, FileRequestListView, FileRequestReviewView } from './pages';
import type { FileRequestDto, FileRequestStatus } from './types';

/**
 * 本模組頁面的 renderer。它們屬於 Theme 那一側：模組宣告頁面與 view，
 * 這裡只決定長相，外框由呼叫端的 Theme 提供（ADR 0045）。插值一律 escapeHtml。
 */
export type LayoutRenderer = (ctx: ThemeContext, title: string, body: string) => string;

const STATUS_LABELS: Record<FileRequestStatus, string> = {
  queued: '排隊處理中', ready_for_review: '等待審核', approved: '已核准', rejected: '已退回', failed: '處理失敗', purging: '清理中',
};

function when(ctx: ThemeContext, value: Date | string | null): string {
  if (!value) return '—';
  return escapeHtml(new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: ctx.timeZone }).format(new Date(value)));
}

function csrfField(ctx: ThemeContext): string {
  return ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : '';
}

function requestTable(ctx: ThemeContext, requests: readonly FileRequestDto[], actions?: (request: FileRequestDto) => string): string {
  if (requests.length === 0) return '<p>目前沒有申請。</p>';
  const rows = requests.map(request => `<tr>
      <td><a href="/file-requests/${escapeHtml(request.id)}">${escapeHtml(request.title)}</a></td>
      <td>${escapeHtml(request.filename)}</td>
      <td>${escapeHtml(STATUS_LABELS[request.status])}</td>
      <td>${when(ctx, request.submittedAt)}</td>
      ${actions ? `<td>${actions(request)}</td>` : ''}
    </tr>`).join('');
  return `<table><thead><tr><th>標題</th><th>檔案</th><th>狀態</th><th>送出時間</th>${actions ? '<th>處理</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * 上傳表單送的是 multipart，而全域 parser 不收欄位、CSRF 只認 header（ADR 0050），
 * 所以這裡用一小段 script 以 fetch 送出：檔案是唯一的 part，標題走 query string。
 * script 裡沒有任何插值，資料只經過已跳脫的 data 屬性傳進去。
 */
function uploadForm(ctx: ThemeContext, view: FileRequestListView): string {
  if (!ctx.csrfToken) return '<p>請重新登入後再上傳。</p>';
  return `<form id="file-request-form" data-upload="${escapeHtml(view.uploadPath)}" data-csrf="${escapeHtml(ctx.csrfToken)}">
    <label for="file-request-title">標題</label>
    <input id="file-request-title" name="title" maxlength="120" required>
    <label for="file-request-file">檔案</label>
    <input id="file-request-file" name="file" type="file" accept="${escapeHtml(view.acceptedTypes.join(','))}" required>
    <button type="submit">送出申請</button>
    <p id="file-request-status" role="status" aria-live="polite"></p>
  </form>
  <script>
  (function () {
    var form = document.getElementById('file-request-form');
    var status = document.getElementById('file-request-status');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var file = form.elements.file.files[0];
      if (!file) return;
      var body = new FormData();
      body.append('file', file);
      status.textContent = '上傳中…';
      fetch(form.dataset.upload + '?title=' + encodeURIComponent(form.elements.title.value), {
        method: 'POST', body: body, credentials: 'same-origin', headers: { 'x-csrf-token': form.dataset.csrf },
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (result) {
          if (response.ok && result && result.data) { window.location.assign('/file-requests/' + result.data.id); return; }
          status.textContent = (result && result.error && result.error.message) || '上傳失敗，請再試一次。';
        });
      }, function () { status.textContent = '上傳失敗，請再試一次。'; });
    });
  })();
  </script>`;
}

export function createFileRequestRenderers(layout: LayoutRenderer) {
  const renderIndex: PageRenderer<FileRequestListView> = (ctx, view) => layout(ctx, '檔案處理申請', `
    <h1>檔案處理申請</h1>
    ${view.canReview ? '<p><a href="/file-requests/review">前往審核頁</a></p>' : ''}
    <h2>送出新的申請</h2>
    ${uploadForm(ctx, view)}
    <h2>我的申請</h2>
    ${requestTable(ctx, view.requests)}
  `);

  const renderDetail: PageRenderer<FileRequestDetailView> = (ctx, { request, canReview }) => layout(ctx, request.title, `
    <p><a href="${canReview ? '/file-requests/review' : '/file-requests'}">返回列表</a></p>
    <h1>${escapeHtml(request.title)}</h1>
    <dl>
      <dt>狀態</dt><dd>${escapeHtml(STATUS_LABELS[request.status])}</dd>
      <dt>檔案</dt><dd>${escapeHtml(request.filename)}（${escapeHtml(request.contentType)}，${request.byteSize} bytes）</dd>
      <dt>送出時間</dt><dd>${when(ctx, request.submittedAt)}</dd>
      <dt>處理完成</dt><dd>${when(ctx, request.analyzedAt)}</dd>
      ${request.lineCount === null ? '' : `<dt>行數</dt><dd>${request.lineCount}</dd>`}
      ${request.sha256 ? `<dt>SHA-256</dt><dd><code>${escapeHtml(request.sha256)}</code></dd>` : ''}
      ${request.failureReason ? `<dt>失敗原因</dt><dd>${escapeHtml(request.failureReason)}</dd>` : ''}
      ${request.decidedAt ? `<dt>審核時間</dt><dd>${when(ctx, request.decidedAt)}</dd>` : ''}
      ${request.reviewNote ? `<dt>審核備註</dt><dd>${escapeHtml(request.reviewNote)}</dd>` : ''}
    </dl>
  `);

  const reviewActions = (ctx: ThemeContext) => (request: FileRequestDto): string => {
    const id = escapeHtml(request.id);
    if (request.status === 'ready_for_review') {
      return `<form method="post" action="/file-requests/review/${id}/decision">${csrfField(ctx)}
        <label for="note-${id}">備註</label><input id="note-${id}" name="note" maxlength="500">
        <button type="submit" name="decision" value="approved">核准</button>
        <button type="submit" name="decision" value="rejected">退回</button>
      </form>`;
    }
    if (request.status === 'failed') {
      return `<form method="post" action="/file-requests/review/${id}/retry">${csrfField(ctx)}<button type="submit">重新處理</button></form>`;
    }
    return '';
  };

  const renderReview: PageRenderer<FileRequestReviewView> = (ctx, view) => layout(ctx, '審核檔案處理申請', `
    <h1>審核檔案處理申請</h1>
    <p>下表列出等待審核與處理失敗的申請。</p>
    ${view.error ? `<p class="notice" role="alert">${escapeHtml(view.error)}</p>` : ''}
    <ul>${(Object.keys(STATUS_LABELS) as FileRequestStatus[]).map(status => `<li>${escapeHtml(STATUS_LABELS[status])}：${view.summary[status]}</li>`).join('')}</ul>
    ${requestTable(ctx, view.requests, reviewActions(ctx))}
  `);

  return {
    'filerequests.request.index': renderIndex,
    'filerequests.request.view': renderDetail,
    'filerequests.review.index': renderReview,
    'filerequests.review.decide': renderReview,
    'filerequests.review.retry': renderReview,
  };
}
