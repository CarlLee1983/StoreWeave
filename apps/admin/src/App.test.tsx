import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {} from '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { I18nProvider } from './i18n';
import { api } from './api';
import { ROUTE_TABLE } from './routes';

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
vi.mock('./pages/LoyaltyPage', () => ({ LoyaltyPage: () => <div>LOYALTY_PAGE</div> }));
vi.mock('./pages/PromotionsPage', () => ({ PromotionsPage: () => <div>PROMOTIONS_PAGE</div> }));
vi.mock('./pages/CouponsPage', () => ({ CouponsPage: () => <div>COUPONS_PAGE</div> }));
vi.mock('./pages/AnalyticsPage', () => ({ AnalyticsPage: () => <div>ANALYTICS_PAGE</div> }));
vi.mock('./pages/CustomersPage', () => ({ CustomersPage: () => <div>CUSTOMERS_PAGE</div> }));
vi.mock('./pages/ErpPage', () => ({ ErpPage: () => <div>ERP_PAGE</div> }));
vi.mock('./pages/SystemPage', () => ({ SystemPage: () => <div>SYSTEM_PAGE</div> }));
vi.mock('./pages/DlqPage', () => ({ DlqPage: () => <div>DLQ_PAGE</div> }));

const renderApp = () => render(<I18nProvider><App /></I18nProvider>);
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;

beforeEach(() => {
  window.location.hash = '';
  vi.mocked(api.listDeadJobs).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.me).mockReset().mockResolvedValue({ id: 'u1', email: 'a@b.c', displayName: 'Admin', role: 'admin' });
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
    expect(labels).toEqual(['訂單', '商品', '配送與出貨', '退貨案件', '電子發票', '促銷活動', '優惠券', '購物金與等級', '會員', '行銷分析', 'ERP 佇列', '死信佇列', '系統健康度']);
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

    expect(labels).toEqual(['訂單', '商品', '配送與出貨', '退貨案件', '電子發票', '促銷活動', '優惠券', '購物金與等級', '會員', '行銷分析', 'ERP 佇列', '死信佇列', '系統健康度']);
  });

  it('Esc 關閉命令面板', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('PRODUCTS_PAGE');

    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog', { name: '命令選單' });
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '命令選單' })).not.toBeInTheDocument());
  });
});
