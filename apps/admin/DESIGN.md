# StoreWeave Admin Design System Specification (DESIGN.md)

This document defines the official design system, architectural principles, typography hierarchy, dual-theme color tokens, and UI component standards for the StoreWeave Admin Dashboard (`apps/admin`).

---

## 1. Core Principles & Philosophy

1. **Engineered Simplicity & Restraint**
   * Inspired by developer-grade platforms such as **Vercel, Linear, and Supabase**.
   * Clean 1px borders, subtle surface elevations, and focused contrast without visual noise or gratuitous decorative elements.
2. **High Information Density & Scannability**
   * Optimized for enterprise commerce workflows and system operators who need to rapidly triage orders, trace ERP payloads, and resolve Dead Letter Queue (DLQ) exceptions.
   * Tabular figures (`tnum`) ensure precise vertical alignment for monetary amounts, order counts, latency metrics, and timestamps.
3. **Strictly Vector SVG Icons — Zero Emojis**
   * All iconography strictly uses geometric 24x24 vector SVGs with consistent stroke weights (`1.75px` or `2px`). Emojis are strictly prohibited anywhere in the UI.
4. **Keyboard-First & Ergonomics**
   * Global command palette (`⌘K`), quick escape triggers (`Esc`), and accessible focus states across all interactive elements.
5. **Multi-Language Adaptability (i18n)**
   * Fluid layout containers accommodate text expansion across different languages (e.g., Traditional Chinese, English, Japanese) without layout shifts or text wrapping defects.

### 1.1 Implemented Admin Boundaries

Server state uses one App-lifetime `QueryClient`; `query.ts` owns query keys, `api.ts` is the sole production HTTP transport, and `routes.tsx` owns the 16 route definitions, navigation, page metadata, and header actions. Queries and mutations set `retry: false`; cache and pending operation recovery are memory-only. Identity changes cancel and clear query cache plus pending operations before new data can render. Commands keep an immutable request and idempotency key while their result is unknown. Only a definite success or rejection ends that operation; only afterwards may a new user action receive a new key.

`Dialog`, `DropdownMenu`, and `Popover` are the shared Radix-backed primitives. React Hook Form and TanStack Table remain deferred until repeated validation or confirmed table sorting, visibility, or selection needs justify them.

---

## 2. Typography System

### 2.1 Font Stacks

* **Primary Interface Font Stack (UI Sans)**:
  ```css
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang TC', 'Noto Sans TC', 'Hiragino Sans', sans-serif;
  ```
* **Monospace Font Stack (Codes, Identifiers, Currency, Timestamps, JSON)**:
  ```css
  font-family: 'JetBrains Mono', 'Geist Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  ```

### 2.2 OpenType Features (Tabular Numbers)
All numeric, monetary, metric, and table cell containers must enforce tabular figures:
```css
font-feature-settings: "cv02", "cv03", "cv04", "cv11", "tnum" 1;
```

### 2.3 Typographic Scale & Hierarchy

| Hierarchy | Size | Weight | Line Height | Letter Spacing | Target Use Cases |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Page Title** | `18px (1.125rem)` | 600 (SemiBold) | 1.3 | `-0.02em` | Module page titles |
| **Section Title** | `14px (0.875rem)` | 600 (SemiBold) | 1.4 | `-0.01em` | Card titles, drawer headers |
| **Body (Default)**| `13px (0.8125rem)` | 400 (Regular) | 1.5 | `normal` | Data table cells, description text |
| **Body Medium** | `13px (0.8125rem)` | 500 (Medium) | 1.5 | `normal` | Navigation links, buttons |
| **Caption / Meta**| `11.5px (0.718rem)`| 500 (Medium) | 1.4 | `0.02em` | Table headers (TH), timestamps, tags |
| **Metric Value** | `20px (1.25rem)` | 600 (SemiBold) | 1.2 | `-0.02em` | Metric cards (Monospace) |

---

## 3. Dual-Theme Color System & Design Tokens

The system provides complete symmetry between **Dark Mode (Zinc 950 base)** and **Light Mode (Slate 50 base)** with verified WCAG AA (4.5:1+) contrast compliance.

```css
/* ==========================================================================
   Dark Theme (Zinc 950 Base)
   ========================================================================== */
:root[data-theme="dark"] {
  /* Surfaces & Backgrounds */
  --bg-app:             #09090b; /* Zinc 950 Canvas */
  --bg-surface:         #121215; /* Primary Card & Table Surface */
  --bg-surface-subtle:  #18181b; /* Zinc 900 Secondary Surface / Table Headers */
  --bg-surface-hover:   #222226; /* Hover Feedback */
  --bg-sidebar:         #0d0d10; /* Sidebar Background */
  --bg-code:            #060608; /* Code Block Background */

  /* Borders & Dividers */
  --border-subtle:      #1f1f23;
  --border-default:     #27272a; /* Zinc 800 Standard Border */
  --border-strong:      #3f3f46; /* Zinc 700 Accent Border */
  --border-focus:       #3b82f6; /* Focus Outline */

  /* Typography Colors */
  --text-primary:       #fafafa; /* Zinc 50 Primary Text (16:1 Contrast) */
  --text-secondary:     #a1a1aa; /* Zinc 400 Secondary Text */
  --text-muted:         #71717a; /* Zinc 500 Placeholders & Badges */
  --text-inverse:       #09090b;

  /* Primary Action Button (High Contrast Inverse) */
  --btn-primary-bg:     #fafafa;
  --btn-primary-text:   #09090b;
  --btn-primary-hover:  #e4e4e7;

  /* Semantic Status Tokens */
  --status-success-bg:     rgba(16, 185, 129, 0.1);
  --status-success-border: rgba(16, 185, 129, 0.25);
  --status-success-text:   #34d399;

  --status-warning-bg:     rgba(245, 158, 11, 0.1);
  --status-warning-border: rgba(245, 158, 11, 0.25);
  --status-warning-text:   #fbbf24;

  --status-error-bg:       rgba(239, 68, 68, 0.1);
  --status-error-border:   rgba(239, 68, 68, 0.25);
  --status-error-text:     #f87171;

  --status-neutral-bg:     rgba(113, 113, 122, 0.1);
  --status-neutral-border: rgba(113, 113, 122, 0.2);
  --status-neutral-text:   #a1a1aa;
}

/* ==========================================================================
   Light Theme (Slate 50 Base)
   ========================================================================== */
:root[data-theme="light"] {
  /* Surfaces & Backgrounds */
  --bg-app:             #f8fafc; /* Slate 50 Canvas */
  --bg-surface:         #ffffff; /* Pure White Card Surface */
  --bg-surface-subtle:  #f1f5f9; /* Slate 100 Toolbar & Header */
  --bg-surface-hover:   #e2e8f0; /* Slate 200 Hover Feedback */
  --bg-sidebar:         #ffffff; /* Clean White Sidebar */
  --bg-code:            #0f172a; /* Slate 900 Code Contrast */

  /* Borders & Dividers */
  --border-subtle:      #f1f5f9;
  --border-default:     #e2e8f0; /* Slate 200 Standard Border */
  --border-strong:      #cbd5e1; /* Slate 300 */
  --border-focus:       #2563eb;

  /* Typography Colors */
  --text-primary:       #0f172a; /* Slate 900 Primary Text (15:1 Contrast) */
  --text-secondary:     #475569; /* Slate 600 Secondary Text */
  --text-muted:         #94a3b8; /* Slate 400 */
  --text-inverse:       #ffffff;

  /* Primary Action Button */
  --btn-primary-bg:     #0f172a;
  --btn-primary-text:   #ffffff;
  --btn-primary-hover:  #1e293b;

  /* Semantic Status Tokens */
  --status-success-bg:     #ecfdf5;
  --status-success-border: #a7f3d0;
  --status-success-text:   #065f46;

  --status-warning-bg:     #fffbeb;
  --status-warning-border: #fde68a;
  --status-warning-text:   #92400e;

  --status-error-bg:       #fef2f2;
  --status-error-border:   #fecaca;
  --status-error-text:     #991b1b;

  --status-neutral-bg:     #f1f5f9;
  --status-neutral-border: #e2e8f0;
  --status-neutral-text:   #475569;
}
```

---

## 4. Semantic SVG Status Badge System

Status indicators must never rely on plain dots or emojis. They incorporate explicit vector SVG geometry to communicate system states:

| Status Variant | Meaning & Use Case | SVG Specification (13×13px) | Visual Styling |
| :--- | :--- | :--- | :--- |
| **Success** | `Paid`, `DELIVERED`, `Connected` | `<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>` | Check Circle (Green) |
| **Warning** | `Processing`, `RETRYING`, `Pending` | `<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>` | Rotate Counter-Clockwise (Amber) |
| **Error** | `Sync Failed`, `DEAD_LETTER (DLQ)` | `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` | Alert Circle (Red) |
| **Neutral** | `Draft`, `Archived`, `Standby` | `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>` | Minus Circle (Muted Gray) |

---

## 5. Layout & Core Components

### 5.1 App Shell Blueprint
```
+-----------------------------------------------------------------------------------------------+
| StoreWeave Admin         | [Search Q ⌘K]                    [Locale] [Theme] [API Token]     |
+--------------------------+--------------------------------------------------------------------+
| [COMMERCE]               | Page Header: Order Management                     [+ Create Order] |
| - Orders           [128] | Subtitle: Real-time transaction stream & ERP delivery pipeline     |
| - Products               +--------------------------------------------------------------------+
|                          | Pipeline: Ingest (1,280/d) -> Queue (0) -> Worker (99.9%) -> DLQ(1)|
| [INTEGRATIONS]           +--------------------------------------------------------------------+
| - ERP Queue      [1 DLQ] | Metric Cards: [ GMV ] [ Pending ] [ ERP Latency ] [ DLQ Alerts ]   |
| - System Health          +--------------------------------------------------------------------+
|                          | Data Table: [ Order ID ] [ Customer ] [ Amount ] [ Status ] [ ... ]|
| [v0.1.0 ● Online]        +--------------------------------------------------------------------+
```

這張圖只是**版型示意**，側欄舉的四頁不是完整清單。頁面的唯一權威是
`apps/admin/src/routes.tsx` 的 `ENTRIES`——路由、側欄標籤、圖示、頁首標題與主要動作
全部從那一份長出來。這裡不再抄一份會漂掉的頁面清單。

### 5.2 Component Guidelines

1. **Sidebar Navigation**:
   * Width: `250px`, fixed left layout; at narrow widths it becomes the existing icon rail.
   * Semantic category labels (`COMMERCE`, `INTEGRATIONS`) in 11px uppercase bold.
   * Badges in monospace with danger variant highlighting Dead Letter Queue count (`1 DLQ`).
2. **Topbar & Utilities**:
   * Fixed height: `60px`.
   * Search input with keyboard badge (`⌘K`).
   * Dynamic Language Switcher (`zh-TW`, `en-US`, `ja-JP`).
   * Theme toggle with dedicated vector Sun / Moon SVGs.
   * Token manager with password input and persistent storage.
3. **Data Table**:
   * Header height: `34px`, row height: `44px`.
   * Monospace alignment for IDs, amounts, and timestamps.
   * Row hover feedback with subtle background contrast transition (`100ms`).
4. **Dialog 與選單 primitive**：
   * `src/components/ui/dialog.tsx`、`dropdown-menu.tsx` 與 `popover.tsx` 是由 [shadcn/ui source distribution](https://ui.shadcn.com/docs) 改寫為既有 token CSS 的 Radix 基底（出處與調整在同目錄 `README.md`）；商務語意留在 `ReasonDialog`、`RowMenu`，不要自行維護 window click listener 或 focus trap。
   * Dialog 使用 `--bg-surface`、`--border-default`、`--border-focus` 與 `--shadow-dropdown`；破壞性確認沿用 `--status-error-*`。
   * `ReasonDialog` 保留 trim 後必填理由；取消、Esc、點擊關閉與關閉後焦點還原均透過 Dialog primitive lifecycle。
   * 相容基準：Node `>=22`、React/React DOM `18.3.1`、Vite `6`；Radix Dialog `1.1.23`、Dropdown Menu `2.1.24` 的 peer range 均包含 React 18。此專案未導入 Tailwind，primitives 直接使用既有 CSS token，避免 reset 影響尚未遷移的頁面。
   * 商品的 create／edit Sheet 是 `DialogContent.ui-product-sheet` 的具象用法：開啟時聚焦首欄、關閉時回到觸發者。列表保持原生 table；窄版由 `.table-wrap` 水平捲動及 `.products-table` 最小寬度保留列操作，不壓縮成不可用的欄位。
5. **Slide-Over Drawer**:
   * Payload 檢視使用 `min(560px, 100vw)`；表單 drawer 使用 `DialogContent` 加頁面語意 class。
   * Slide in from right with subtle backdrop blur.
   * Drawer 一律透過 Dialog primitive 處理 Esc、focus trap 與回焦。
   * Payload 檢視提供格式化 JSON、一鍵複製與「Replay Event」動作。

6. **長文編輯表單**：
   * 抽屜內的欄位排在 `.form-grid`（兩欄）。**內文這類長文欄位要跨兩欄**：
     加 `.form-field--full`（`.form-grid > .form-field--full { grid-column: 1 / -1 }`）。
   * 欄位說明（`.field-hint`）放進 `<label>` 內，不要當成 `.form-grid` 的直接子元素——
     那會讓它自己佔掉一個格子。
   * `textarea` 用 `min-height`，不自訂固定高度；其餘控制項維持 34px。

---

## 6. Internationalization (i18n) Standards

1. **Namespace Structure**:
   * 目前 `apps/admin/src/i18n.tsx` 是一份**扁平**字典，不是巢狀 namespace；上面的
     `nav.*` 這種寫法是原始設計意圖，實際的 key 是 `brandContentTitle`、`createArticle`
     這類扁平名稱。新增頁面時照既有慣例以頁面名為前綴，並且**三個語系（zh-TW / en-US / ja-JP）
     一次補齊**——少一個 TypeScript 就會擋下來，那是刻意的。
2. **Flexible Container Widths**:
   * Never hardcode fixed pixel widths on action buttons, column headers, or badges. Use `min-width` and standard padding to prevent text wrapping in longer languages.
3. **Text Truncation**:
   * Truncated strings must enforce `text-overflow: ellipsis; white-space: nowrap; overflow: hidden;` accompanied by native `title` DOM attributes.
4. **Locale Formatting**:
   * All currency and date rendering must pass through `Intl.NumberFormat` and `Intl.DateTimeFormat`.
