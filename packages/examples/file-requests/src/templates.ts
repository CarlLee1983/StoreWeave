import type { NotificationTemplate } from '@storeweave/notifications';

/**
 * 通知模板。版本號與內容一起存進通知紀錄，改了模板也改不動已排隊的那一封（ADR 0040）；
 * 改內容就提高 version。email 的 HTML 不放變數：申請標題是使用者輸入，只進純文字與主旨。
 */
export const reviewNeededTemplate: NotificationTemplate = {
  id: 'filerequests.review-needed',
  version: 1,
  email: {
    subject: '檔案處理申請待審核：{title}',
    text: '「{title}」已完成背景處理，請到 {reviewUrl} 審核。',
    html: '<p>有一筆檔案處理申請已完成背景處理，正在等待審核。</p>',
  },
};

export const analysisReadyTemplate: NotificationTemplate = {
  id: 'filerequests.analysis-ready',
  version: 1,
  inapp: { title: '檔案已處理完成', body: '「{title}」已完成處理，正在等待審核。' },
};

export const processingFailedTemplate: NotificationTemplate = {
  id: 'filerequests.processing-failed',
  version: 1,
  inapp: { title: '檔案處理失敗', body: '「{title}」無法處理：{reason}' },
};

export const decidedTemplate: NotificationTemplate = {
  id: 'filerequests.decided',
  version: 1,
  inapp: { title: '檔案處理申請已審核', body: '「{title}」的審核結果：{decision}。{note}' },
};
