# 模組開發

模組是有自己資料表的功能：它擁有 migration、權限、Command／Query、事件、背景工作與頁面，
經由 `defineModule({...})`（`packages/platform/kernel/src/module.ts`）接入 base。
只接外部服務、資料由對方保管的需求寫 [Extension](extension-development.md)；只改長相的需求寫 Theme。

新增一個模組只動兩處，不改 base：

1. **模組套件**：`packages/<產品目錄>/<模組>/`。
2. **站點組裝**：這個網站的 release 檔（`packages/platform/bundle/src/releases/<id>.ts`、`apps/api/src/releases/<id>.ts`），
   以及把 release 登記進建置的 `scripts/releases.mjs`、`scripts/build-release.sh`、`scripts/seeds/<id>.ts`。

整份文件以可執行的範例對照：模組 [`packages/examples/file-requests`](../packages/examples/file-requests/src/module.ts)（檔案處理申請），
release [`file-requests`](../packages/platform/bundle/src/releases/file-requests.ts)。它跑通「授權上傳 → 排 job → 背景處理 →
狀態查詢 → 審核 → 寄信與站內通知 → 排程清理」，端到端測試在 `tests/integration/file-requests-example.test.ts`。
設計決策見 [ADR 0050](adr/0050-modules-declare-resources-and-upload-intakes.md)。完成的定義沿用 `AGENTS.md`：`make verify` 通過。

## 1. 建立套件

- `package.json` 的 `version` 就是模組版本；模組以 `packageJson.version` 宣告，相依方用 semver range 指它。
- `tsconfig.base.json` 的 `paths` 加 `@storeweave/<套件>` 別名；新的產品目錄在 `pnpm-workspace.yaml` 補 glob
  （範例的 `packages/examples/*`），然後 `pnpm install` 讓 lockfile 認得新套件——CI 用 `--frozen-lockfile`。
- 模組寫成工廠函式 `createXxxModule(options)`。選項只能被 handler 捕捉：模組圖、migration 與 job 宣告
  不可隨設定改變（`ReleaseDefinition.createModules` 的約定，組裝時會比對）。

| 範例檔案 | 內容 |
| --- | --- |
| `src/module.ts` | 唯一的 `defineModule` 呼叫，把下面各檔接起來 |
| `src/schema.ts`、`src/migrations.ts` | Drizzle 表定義與 SQL migration，表名一致 |
| `src/types.ts` | 狀態、權限鍵、DTO 與每支 Command／Query 的 strict input |
| `src/repository.ts` | 只有本模組讀寫自己的表 |
| `src/commands.ts`、`src/queries.ts` | 寫入與讀取；範圍依 `ctx.actor` 限縮 |
| `src/events.ts`、`src/templates.ts` | 版本化事件、通知模板 |
| `src/jobs.ts` | 背景處理與排程清理 |
| `src/pages.ts`、`src/theme.ts` | 頁面宣告與 view；renderer 屬於 Theme 那一側 |

## 2. 模組身分與相依

```ts
name: 'file-requests',            // ^[a-z][a-z0-9-]*$，也是事件訂閱者 id
version: packageJson.version,
baseVersionRange: '^1.0.0',       // Base ABI，與套件版本無關
dependencies: { required: [
  { name: 'platform', versionRange: '^0.1.0' },
  { name: 'platform-storage', versionRange: '^0.1.0' },
  { name: 'platform-cache', versionRange: '^0.1.0' },
  { name: 'platform-notifications', versionRange: '^0.1.0' },
] },
```

用到哪個 base 能力就列哪個平台模組。缺少相依、版本不符、名稱或資料表撞名，都在建立資料庫之前被模組圖拒絕（ADR 0036）。

## 3. 資料與 migration

- 表名以模組名為前綴（`-` 換成 `_`）：範例只有 `file_requests_records`。**每一張**都列進 `data.owns`。
- migration id 模組內單調遞增（`0001_init`、`0002_…`）。已發布的 migration 內容凍結，變更寫成下一個 id；
  `phase` 用 `expand`／`migrate`／`contract` 表達它與舊版程式的相容性。
- migration 只建結構，預設資料由 release 以選項傳入（ADR 0046）。指向別的模組的 id 不加外鍵（ADR 0021）——
  範例的 `storage_object_id` 指向 platform storage 物件，生命週期由本模組的清理工作負責。
- 狀態轉換寫成帶條件的 UPDATE（「還是 `queued` 而且是同一個 `generation`」），重送與併發因此只生效一次。

## 4. 權限與角色

模組宣告權限鍵，`owner` 等於模組名；**誰拿到權限是 release 決定的**。範例的 release 在 `BASE_ROLES` 上加授：

```ts
staff:  withPermissions(BASE_ROLES.staff!,  ['file-requests:submit', 'file-requests:review', 'file-requests:process']),
member: withPermissions(BASE_ROLES.member!, ['file-requests:submit']),
```

每個宣告的權限都要至少發給一個角色（`admin` 的 `*` 不算），否則契約測試失敗。
「只看自己的」在 handler 裡依 `ctx.actor` 限縮；別人的資料回 404，不透露 id 存在。

## 5. Command、Query 與事件

- 名稱是公開契約：`<context>.<aggregate>.<action>`。context 只能是小寫英數（事件名稱的格式如此規定），
  所以模組 `file-requests` 的 context 是 `filerequests`：`filerequests.request.submit`、`filerequests.request.submitted.v1`。
- `input` 一律是平的 `z.object({...}).strict()`（ADR 0024）。
- 副作用與資料同一筆交易：`ctx.publish`（Outbox）、`ctx.enqueue`（背景工作）、`ctx.audit`／descriptor 的 `audit`。
- 事件形狀改變時發 `.v2`，舊版保留到沒有訂閱者為止。

## 6. 上傳入口

檔案不走 Command Bus。模組宣告一個 intake，由通用端點收件：

```ts
resources: ['cache', 'storage'],
uploads: [{
  name: 'request-file',
  contentTypes: ['text/plain', 'text/csv'],
  command: 'filerequests.request.submit',   // 本模組的 Command，strict input 要有 storageObjectId
}],
```

`POST /api/v1/modules/file-requests/uploads/request-file?title=…` 的處理順序是固定的：
以收件 Command 的權限授權 → 以 `{ ...query, storageObjectId }` 預先驗證它的 input → 串流寫進本模組的私有 storage scope
（owner 是呼叫者）→ 以同一個 actor 執行收件 Command。Command 失敗就刪掉剛寫入的物件。端點套用 `upload` 節流桶，
base 與 commerce 的 HTTP adapter 都已掛上它。

- 收件 Command 不能 `idempotency: 'required'`：每次上傳都是新的位元組，重播舊結果會指向另一個物件。
- 收件 Command 要自己核對 `object.ownerActorId === ctx.actor.id`，別人的物件 id 送進來一律 404。
- 自助註冊的會員也拿得到上傳入口時，配額是模組的責任：範例在收件 Command 裡以 advisory lock 排隊，
  每人未結案的申請超過上限就回 409，入口隨即刪掉剛寫入的物件。
- 會進信件主旨的欄位要拒絕換行等控制字元，否則寄信工作會在事後失敗。
- 全域 multipart parser 只收一個檔案 part、不收欄位，session 的 CSRF 只認 `X-CSRF-Token` header，
  所以瀏覽器頁面以 `fetch` 送出（範例 `src/theme.ts` 的 `uploadForm`）；API token 呼叫不需要 CSRF。

## 7. Storage、Cache 與 Mutex

```ts
resources: ['cache', 'storage'],
bindResources: bound => { resources = bound; },   // { cache, mutex, storage }，只有宣告過的
```

runtime 在任何 handler 執行前呼叫一次 `bindResources`，給的 scope 固定在由模組名推導的 namespace：
模組清不到別人的快取、讀不到別人的物件，也拿不到 manager。宣告與 hook 必須成對。

快取不是事實來源。範例的審核計數快取 30 秒、寫入時刪鍵、讀寫失敗只記 log 並回資料庫重算。
帳本、session 撤銷或任何安全決策不能只存在快取（B11）。

## 8. 通知與信件

```ts
bindPorts: ports => { notifications = ports.notifications; },
```

在 Command 裡用 `notifications.send(ctx.tx, request, ctx.enqueue, ctx.now)`：通知與狀態同一筆交易，
`reference` 讓重送只通知一次，`inapp` 的收件人是 `ctx.actor.id`，`email` 需要位址（範例的審核信收件人由 release 從
`store.supportEmail` 傳入）。模板帶 `version`，內容快照隨通知保存；改內容就提高版本（ADR 0040）。
使用者輸入只放進純文字與主旨，不插進 email HTML。`mail.transport` 為 `disabled` 時信件記成 `skipped`。

## 9. 背景工作與排程

```ts
jobs: [
  { type: 'filerequests.process', handler, jobContractV1: { currentVersion: 1, versions: { 1: processJobPayload } } },
  { type: 'filerequests.cleanup', handler, jobContractV1: { currentVersion: 1, versions: { 1: cleanupJobPayload } },
    schedule: { cron: '30 3 * * *', timezone: 'Asia/Taipei', overlap: 'skip' } },
],
```

- 每個 job 都有 `jobContractV1`；改 payload 形狀時保留舊版 schema、提高 `currentVersion`。
- 排程只 enqueue、由 Worker 執行。`{ cron, timezone }` 產生 `{ scheduledFor }`，`{ everyMs }` 產生 `{ bucket, scheduledFor }`，
  contract 必須讀得懂它。
- Job 沒有資料庫握柄：讀走 `ctx.executeQuery`、寫走 `ctx.executeCommand`（以 system 身分），位元組從自己的 storage scope 讀。
- 暫時性故障就拋錯，交給 Worker 重試；內容本身不可處理就記成失敗。最後一次嘗試（`ctx.attempt` 達到
  `DEFAULT_JOB_MAX_ATTEMPTS`）仍失敗也記成失敗：進了死信的工作不會更新領域狀態，申請會永遠卡在排隊中。
- 外部副作用用 `ctx.idempotencyKey`；一次 job 內有多批寫入時，冪等鍵要由該批內容決定，重試才不會重播到上一批。
- 清理要有明確目標：範例只動自己表裡已結束且超過保留期的申請。每批先以 Command 標成 `purging`（之後不能被重新處理），
  再刪自己 namespace 的物件，最後刪列；中途失敗重跑安全。

## 10. 頁面與 Theme

頁面由模組宣告、Theme 渲染（ADR 0045）。

- `audience: 'public' | 'customer' | 'operator'`。base release 的會員與後台帳號都是 `user`，因此範例的「我的申請」與審核頁都用
  `operator`，差別由 Query／Command 的權限決定。非商務模組的後台畫面就是這種模組頁面（ADR 0050）。
- 寫入頁用表單 POST，成功回 `redirect`（PRG），業務拒絕回 `view` 加 `status: 400`；表單帶 `_csrf`。
- 審核這類工作清單要依「需要有人動手」的狀態分開查，不要不篩狀態取前 N 筆：保留期內的結案資料會把待處理的擠出去。
- renderer 放在模組的 `src/theme.ts`，但它屬於 Theme：接收外框函式，插值一律 `escapeHtml`。
  release 把它們併進選用的 Theme，外框沿用 base Theme 的 `renderBaseLayout`：

```ts
const fileRequestsTheme: StorefrontTheme = {
  ...baseTheme,
  renderers: { ...baseTheme.renderers, ...createFileRequestRenderers(renderBaseLayout) },
};
```

模組宣告的必需頁面缺 renderer，啟動時就拒絕。

## 11. 組進 release

`packages/platform/bundle/src/releases/file-requests.ts`：角色、Theme、導覽與模組選項都在這裡。

```ts
createModules: ({ config }) => [
  createSiteModule({ defaultNavigation: [...BASE_NAVIGATION, navigationItem({ menu: 'primary', label: '檔案處理申請', href: '/file-requests', position: 90 })], ownsHomePage: true }),
  createContentModule({ ... }),
  createAuthModule({ signedInActorTypes: ['user'] }),
  createFileRequestsModule({ reviewUrl: new URL('/file-requests/review', config.http.publicUrl).toString(), reviewerEmail: config.store.supportEmail }),
],
```

`apps/api/src/releases/file-requests.ts`：HTTP 組裝完全沿用 base——模組頁面由 storefront controller 從宣告生成，
上傳入口 base 已經掛上——只換 release id。

```ts
export const httpAdapter: ReleaseHttpAdapter = { ...baseHttpAdapter, releaseId: 'file-requests' };
```

需要自己組 controllers 的 release，照 `apps/api/src/releases/base.ts` 寫完整的 adapter，頁面的 session 簽發接到
`this.startSession`（工單 92 的守衛檢查這件事）。
最後把 release id 登記進 `scripts/releases.mjs`、`scripts/build-release.sh` 的 `case` 與 `scripts/seeds/<id>.ts`，
`STOREWEAVE_RELEASE=file-requests pnpm build` 就會建出這個網站。

## 12. 測試

**契約測試**（不連資料庫）：`runModuleContractChecks(release, moduleName)` 以 release 為範圍檢查

- 模組圖：相依存在、版本相符、Base range、名稱／權限／資料表撞名、上傳入口與資源宣告；
- 每個宣告的權限都發給了角色；Command／Query 的 input 拒絕未知欄位而且是平的 object；
- migration 只建立 `data.owns` 裡的表、表名帶模組前綴、migration id 依序；
- 每個 job 有 payload contract，排程產生的 payload 讀得懂；
- 必需頁面在 release 的每個 Theme 都有 renderer。

```ts
import { runModuleContractChecks } from '@storeweave/bundle';
import { release } from '../../../platform/bundle/src/releases/file-requests';

it('符合模組契約', () => {
  expect(runModuleContractChecks(release, 'file-requests').filter(check => !check.ok)).toEqual([]);
});
```

表名前綴一項針對新的產品模組；平台模組沿用 `platform_` 前綴，不以這支檢查它們。

**整合測試**：照 `tests/integration/file-requests-example.test.ts` 用 `bootstrapRelease` 起真的 release、
`createReleaseServer` 起 HTTP、`new Worker(runtime).drain()` 跑背景工作。每個模組至少覆蓋：
migration 重跑為空、有權限／無權限（含匿名與 CSRF）、未知欄位回 400、頁面 POST 成功 303／失敗 400、
job 在 Worker 重啟後重試且副作用只發生一次、清理不影響其他模組。

**邊界測試**：`tests/architecture/module-example-boundaries.test.ts` 掃描範例的 import——執行期檔案只經過 base 公開入口、
不引用 Theme 層；Theme 檔只做渲染。新模組照這份加一支自己的。

## 停用、升級與移除

- migration history 不因停用而重置；停用的 owner 保留 metadata，重新啟用時驗證歷史與資料表（ADR 0037）。沒有自動 DROP。
- 升級改了 job payload，就保留舊版 schema 讓排隊中的工作讀得懂；改了事件形狀，發新版本事件。
- 通知模板以版本快照保存，已排隊的通知不受模板修改影響。
- 模組 namespace 裡的 storage 物件與快取不會隨停用被清掉；要移除模組，先讓它的工作排空、以它自己的清理流程處理資料，
  再從 release 移除。

## 啟動時常見的組裝錯誤

| 訊息 | 原因 |
| --- | --- |
| `module "x" requires missing module "y"` | `dependencies.required` 列了 release 沒組進來的模組 |
| `module "x" requires y@^2.0.0, found 1.0.0` | 相依版本範圍不符 |
| `command "a.b.c" is declared by both "x" and "y"` | 名稱撞到別的模組（事件、Query、job、權限、資料表同理） |
| `module "x" declares resources but has no bindResources` | `resources` 與 `bindResources` 沒有成對 |
| `module "x" declares uploads but not the storage resource` | 上傳入口需要 `resources: ['storage']` |
| `module "x" upload "u" command "c" does not accept storageObjectId` | 收件 Command 的 input 沒有 `storageObjectId` |
| `module "x" upload "u" command "c" must not require an idempotency key` | 收件 Command 設了 `idempotency: 'required'` |
| `Invalid event name "..."` | 事件名稱不是 `<context>.<aggregate>.<action>.vN`，context 只能小寫英數 |
| `Theme 'base' 缺少 N 個必需頁面` | release 的 Theme 沒有併入模組頁面的 renderer |
