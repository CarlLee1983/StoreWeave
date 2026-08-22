# 11 — 前台守衛改為三段式

**What to build:** 前台開始認得登入者。守衛依序嘗試：機器對機器的 token、session cookie、最後才退回匿名訪客。在此之前「不需要 token」的端點會被強制當成匿名，即使帶著有效的 cookie —— 這是前台無法有會員的結構性原因。

**Blocked by:** 05

**Status:** done

- [x] 守衛依 token、cookie、匿名的順序解析身分
- [x] 所有既有標示為不需 token 的端點行為不變，並逐一有測試佐證
- [x] 前台的寫入端點受跨站請求偽造保護
- [x] 匿名訪客仍然可以瀏覽商品

使用者決定（2026-08-22）：守衛全面改三段式，但 `auth/login`、`health/live`、`health/ready`、
storefront 的 `POST /checkout` 四支維持強制匿名，改用新的 `@Anonymous()` 標記。
checkout 那條與 CONTEXT.md「結帳必須是已登入 Customer」相衝，會在工單 21 拿掉。
