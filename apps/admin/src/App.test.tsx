import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { App } from './App';
import { I18nProvider } from './i18n';
import { api, getToken, setToken } from './api';
import { ROUTE_TABLE } from './routes';
import { createAdminQueryClient, deadJobKeys } from './query';
import { createAdminOperationStore, AdminOperationProvider } from './admin-operations';

/**
 * 後台外殼的導覽與路由行為（工單 02）。
 *
 * 這些斷言描述的是重構前就成立的行為：路由表化之後它們必須逐字不變。
 * 頁面內容各自有自己的測試，這裡把它們換成標記，只驗外殼。
 */

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
    setToken: vi.fn(),
    api: { me: vi.fn(), listDeadJobs: vi.fn(), logout: vi.fn() },
  };
});

vi.mock('./pages/ProductsPage', () => ({ ProductsPage: () => <div>PRODUCTS_PAGE</div> }));
vi.mock('./pages/OrdersPage', () => ({ OrdersPage: () => <div>ORDERS_PAGE</div> }));
vi.mock('./pages/ShippingPage', () => ({ ShippingPage: () => <div>SHIPPING_PAGE</div> }));
vi.mock('./pages/RmaPage', () => ({ RmaPage: () => <div>RMA_PAGE</div> }));
vi.mock('./pages/InvoicesPage', () => ({ InvoicesPage: () => <div>INVOICES_PAGE</div> }));
vi.mock('./pages/NotificationsPage', () => ({ NotificationsPage: () => <div>NOTIFICATIONS_PAGE</div> }));
vi.mock('./pages/LoyaltyPage', () => ({ LoyaltyPage: () => <div>LOYALTY_PAGE</div> }));
vi.mock('./pages/PromotionsPage', () => ({ PromotionsPage: () => <div>PROMOTIONS_PAGE</div> }));
vi.mock('./pages/CouponsPage', () => ({ CouponsPage: () => <div>COUPONS_PAGE</div> }));
vi.mock('./pages/AnalyticsPage', () => ({ AnalyticsPage: () => <div>ANALYTICS_PAGE</div> }));
vi.mock('./pages/CustomersPage', () => ({ CustomersPage: () => <div>CUSTOMERS_PAGE</div> }));
vi.mock('./pages/ErpPage', () => ({ ErpPage: () => <div>ERP_PAGE</div> }));
vi.mock('./pages/SystemPage', () => ({ SystemPage: () => <div>SYSTEM_PAGE</div> }));
vi.mock('./pages/DlqPage', () => ({ DlqPage: () => <div>DLQ_PAGE</div> }));
vi.mock('./pages/BrandContentPage', () => ({ BrandContentPage: () => <div>BRAND_CONTENT_PAGE</div> }));
vi.mock('./pages/ContactInboxPage', () => ({ ContactInboxPage: () => <div>CONTACT_INBOX_PAGE</div> }));

const renderApp = ({ client = createAdminQueryClient(), store = createAdminOperationStore() }: { client?: QueryClient; store?: ReturnType<typeof createAdminOperationStore> } = {}) => render(
  <QueryClientProvider client={client}>
    <AdminOperationProvider value={store}><I18nProvider><App /></I18nProvider></AdminOperationProvider>
  </QueryClientProvider>,
);
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
/** 側欄依權限與模組過濾，所以測試身分要說得出這個 release 載了什麼（B13 片3）。 */
const MODULES = ROUTE_TABLE.flatMap((entry) => (entry.module ? [entry.module] : []));

beforeEach(() => {
  window.location.hash = '';
  vi.mocked(getToken).mockReturnValue('test-token');
  vi.mocked(api.listDeadJobs).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.me).mockReset().mockResolvedValue({ id: 'u1', email: 'a@b.c', displayName: 'Admin', role: 'admin', permissions: ['*'], modules: MODULES });
});

afterEach(() => { window.location.hash = ''; });

describe('後台外殼的導覽', () => {
  it('側欄依 Commerce 與 Integrations 兩組列出路由表上的每一頁', async () => {
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    expect(screen.getByText('Commerce')).toBeInTheDocument();
    expect(screen.getByText('Integrations')).toBeInTheDocument();

    const nav = screen.getByLabelText('主要導覽');
    const labels = Array.from(nav.querySelectorAll('.nav-link')).map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual(['訂單', '商品', '配送與出貨', '退貨案件', '電子發票', '促銷活動', '優惠券', '購物金與等級', '會員', '品牌內容', '聯絡收件匣', '行銷分析', '通知紀錄', 'ERP 佇列', '死信佇列', '系統健康度', '媒體庫', '操作者帳號', 'API Token', '站內通知', '我的帳號']);
  });

  it('預設進到商品頁，標題與副標題正確', async () => {
    renderApp();

    expect(await screen.findByText('PRODUCTS_PAGE')).toBeInTheDocument();
    expect(heading()).toBe('商品管理');
    expect(screen.getByText('管理商品目錄、售價與可用庫存')).toBeInTheDocument();
  });

  it('無法辨識的 hash 落回商品頁', async () => {
    window.location.hash = '#/does-not-exist';
    renderApp();

    expect(await screen.findByText('PRODUCTS_PAGE')).toBeInTheDocument();
  });

  it('每一個導覽項目都切得過去，標題跟著換', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    const cases: [string, string, string][] = [
      ['訂單', 'ORDERS_PAGE', '訂單管理'],
      ['ERP 佇列', 'ERP_PAGE', 'ERP 投遞'],
      ['死信佇列', 'DLQ_PAGE', '死信佇列'],
      ['系統健康度', 'SYSTEM_PAGE', '系統狀態'],
      ['商品', 'PRODUCTS_PAGE', '商品管理'],
    ];

    for (const [label, marker, title] of cases) {
      await user.click(screen.getByLabelText(label));
      expect(await screen.findByText(marker)).toBeInTheDocument();
      expect(heading()).toBe(title);
    }
  });

  it('切換頁面會把路由寫進 hash', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await user.click(screen.getByLabelText('訂單'));
    await screen.findByText('ORDERS_PAGE');
    expect(window.location.hash).toBe('#/orders');
  });

  it('只有商品頁有主要動作按鈕', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');
    expect(screen.getByRole('button', { name: '+ 建立商品' })).toBeInTheDocument();

    await user.click(screen.getByLabelText('訂單'));
    await screen.findByText('ORDERS_PAGE');
    expect(screen.queryByRole('button', { name: /建立商品/ })).not.toBeInTheDocument();
  });

  it('訂單掛著 LIVE 標記，死信佇列在有死信時顯示數量', async () => {
    vi.mocked(api.listDeadJobs).mockResolvedValue({ items: [], total: 4 });
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    expect(screen.getByText('LIVE')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
    expect(screen.getByText('4')).toHaveClass('nav-badge--error');
  });

  it('沒有死信時不顯示數量標記', async () => {
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await waitFor(() => expect(api.listDeadJobs).toHaveBeenCalled());
    expect(document.querySelector('.nav-badge--error')).toBeNull();
  });

  it('死信計數初次讀取失敗時顯示可存取的錯誤標記，不偽裝成零', async () => {
    vi.mocked(api.listDeadJobs).mockRejectedValue(new Error('badge unavailable'));
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    expect(await screen.findByLabelText('死信佇列數量無法讀取')).toHaveTextContent('!');
  });

  it('一般重新讀取失敗時保留最後成功的死信計數', async () => {
    const client = createAdminQueryClient();
    vi.mocked(api.listDeadJobs).mockResolvedValueOnce({ items: [], total: 4 }).mockRejectedValueOnce(new Error('refresh failed'));
    renderApp({ client });
    await screen.findByText('4');

    void client.invalidateQueries({ queryKey: deadJobKeys.lists });
    await waitFor(() => expect(api.listDeadJobs).toHaveBeenCalledTimes(2));
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.queryByLabelText('死信佇列數量無法讀取')).not.toBeInTheDocument();
  });
});

describe('路由表驅動的外殼', () => {
  it('側欄的項目數與路由表一致，每一列都導得過去且有自己的標題', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    const links = screen.getByLabelText('主要導覽').querySelectorAll('.nav-link');
    expect(links).toHaveLength(ROUTE_TABLE.length);

    const titles = new Set<string>();
    for (const entry of ROUTE_TABLE) {
      await user.click(screen.getByLabelText(links[ROUTE_TABLE.indexOf(entry)].getAttribute('aria-label')!));
      await waitFor(() => expect(window.location.hash).toBe(`#/${entry.path}`));
      const title = heading();
      expect(title, entry.path).toBeTruthy();
      titles.add(title!);
    }
    expect(titles.size).toBe(ROUTE_TABLE.length);
  });
});

describe('依權限與模組組裝的側欄', () => {
  it('權限少的操作者只看到做得到的頁，命令面板也一樣', async () => {
    const user = userEvent.setup();
    vi.mocked(getToken).mockReturnValue('');
    vi.mocked(api.me).mockResolvedValue({
      id: 'u2', email: 'staff@b.c', displayName: 'Staff', role: 'readonly',
      permissions: ['order:read', 'jobs:read'], modules: MODULES,
    });
    renderApp();
    await screen.findByText('ORDERS_PAGE');

    const labels = [...screen.getByLabelText('主要導覽').querySelectorAll('.nav-link')]
      .map((link) => link.getAttribute('aria-label'));
    expect(labels).toEqual(['訂單', '死信佇列', '系統健康度', '我的帳號']);

    await user.keyboard('{Meta>}k{/Meta}');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(4);
  });

  it('模組沒有載入時，那一頁不在側欄裡', async () => {
    vi.mocked(getToken).mockReturnValue('');
    vi.mocked(api.me).mockResolvedValue({
      id: 'u3', email: 'admin@b.c', displayName: 'Admin', role: 'admin',
      permissions: ['*'], modules: MODULES.filter((name) => name !== 'rma'),
    });
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    const labels = [...screen.getByLabelText('主要導覽').querySelectorAll('.nav-link')]
      .map((link) => link.getAttribute('aria-label'));
    expect(labels).not.toContain('退貨案件');
    expect(labels).toContain('訂單');
  });
});

describe('命令面板', () => {
  it('⌘K 開啟後可搜尋並前往頁面', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await user.keyboard('{Meta>}k{/Meta}');
    const search = await screen.findByPlaceholderText('搜尋頁面…');

    await user.type(search, 'ERP');
    const options = screen.getByRole('dialog', { name: '命令選單' }).querySelectorAll('button');
    expect(options).toHaveLength(1);

    await user.click(options[0]);
    expect(await screen.findByText('ERP_PAGE')).toBeInTheDocument();
  });

  it('命令面板列出的項目與側欄一致', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await user.keyboard('{Meta>}k{/Meta}');
    const dialog = await screen.findByRole('dialog', { name: '命令選單' });
    const labels = Array.from(dialog.querySelectorAll('button')).map((el) => el.textContent);

    expect(labels).toEqual(['訂單', '商品', '配送與出貨', '退貨案件', '電子發票', '促銷活動', '優惠券', '購物金與等級', '會員', '品牌內容', '聯絡收件匣', '行銷分析', '通知紀錄', 'ERP 佇列', '死信佇列', '系統健康度', '媒體庫', '操作者帳號', 'API Token', '站內通知', '我的帳號']);
  });

  it('Esc 關閉命令面板', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    const trigger = screen.getByRole('button', { name: '開啟命令選單' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: '命令選單' });
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '命令選單' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('命令面板以方向鍵與 Enter 選頁，並提供選項語意', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await user.click(screen.getByRole('button', { name: '開啟命令選單' }));
    const dialog = await screen.findByRole('dialog', { name: '命令選單' });
    const listbox = within(dialog).getByRole('listbox', { name: '前往' });
    const search = within(dialog).getByRole('combobox');
    expect(search).toHaveAttribute('aria-controls', listbox.id);
    expect(search).toHaveAttribute('aria-activedescendant', 'command-option-orders');
    await user.tab();
    expect(document.activeElement).not.toHaveClass('command-palette__option');
    await user.click(search);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(await screen.findByText('SHIPPING_PAGE')).toBeInTheDocument();
  });

  it('到底時維持最後一個選項且不讓它成為 Tab stop', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await user.click(screen.getByRole('button', { name: '開啟命令選單' }));
    const search = await screen.findByRole('combobox');
    await user.keyboard('{ArrowDown}'.repeat(ROUTE_TABLE.length + 1));

    expect(search).toHaveAttribute('aria-activedescendant', `command-option-${ROUTE_TABLE[ROUTE_TABLE.length - 1].path}`);
    expect(screen.getByRole('option', { name: '我的帳號' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('API token panel', () => {
  it('關閉未儲存草稿後，重新開啟會從已儲存 token 重設', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    const trigger = screen.getByRole('button', { name: 'API Token 設定' });
    await user.click(trigger);
    const input = await screen.findByPlaceholderText('輸入 API token');
    await user.clear(input);
    await user.type(input, 'unsaved-token');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'API Token' })).not.toBeInTheDocument());
    await user.click(trigger);
    expect(await screen.findByPlaceholderText('輸入 API token')).toHaveValue('test-token');
  });

  it('saving a replacement token clears admin operations before cancelling and clearing Query', async () => {
    const user = userEvent.setup();
    const client = createAdminQueryClient();
    const store = createAdminOperationStore();
    const cancel = vi.spyOn(client, 'cancelQueries');
    const clear = vi.spyOn(client, 'clear');
    const clearOperations = vi.spyOn(store, 'clearIdentity');
    renderApp({ client, store });
    await screen.findByText('PRODUCTS_PAGE');
    await user.click(screen.getByRole('button', { name: 'API Token 設定' }));
    const input = await screen.findByPlaceholderText('輸入 API token');
    await user.clear(input);
    await user.type(input, 'replacement-token');
    await user.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(clearOperations).toHaveBeenCalledBefore(cancel);
    expect(cancel).toHaveBeenCalledBefore(clear);
    expect(vi.mocked(setToken)).toHaveBeenCalledWith('replacement-token');
  });

  it('identity transition hides the old page until cancellation clears its cache and ignores a late old dead-job result', async () => {
    const user = userEvent.setup();
    const client = createAdminQueryClient();
    let resolveOldDeadJobs!: (value: { items: never[]; total: number }) => void;
    const oldDeadJobs = new Promise<{ items: never[]; total: number }>((resolve) => { resolveOldDeadJobs = resolve; });
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => { resolveCancellation = resolve; });
    vi.mocked(api.listDeadJobs).mockImplementationOnce(() => oldDeadJobs).mockResolvedValueOnce({ items: [], total: 2 });
    vi.spyOn(client, 'cancelQueries').mockImplementation(() => cancellation);
    renderApp({ client });
    await screen.findByText('PRODUCTS_PAGE');
    await user.click(screen.getByRole('button', { name: 'API Token 設定' }));
    const input = await screen.findByPlaceholderText('輸入 API token');
    await user.clear(input);
    await user.type(input, 'new-identity');
    await user.click(screen.getByRole('button', { name: '儲存' }));
    expect(screen.queryByText('PRODUCTS_PAGE')).not.toBeInTheDocument();
    expect(screen.getByText('載入中…')).toBeInTheDocument();
    resolveCancellation();
    await screen.findByText('PRODUCTS_PAGE');
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    resolveOldDeadJobs({ items: [], total: 9 });
    await Promise.resolve();
    expect(screen.queryByText('9')).not.toBeInTheDocument();
  });
});
