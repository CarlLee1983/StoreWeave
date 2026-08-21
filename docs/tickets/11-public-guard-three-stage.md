# 11 — 前台守衛改為三段式

**What to build:** 前台開始認得登入者。守衛依序嘗試：機器對機器的 token、session cookie、最後才退回匿名訪客。在此之前「不需要 token」的端點會被強制當成匿名，即使帶著有效的 cookie —— 這是前台無法有會員的結構性原因。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 守衛依 token、cookie、匿名的順序解析身分
- [ ] 所有既有標示為不需 token 的端點行為不變，並逐一有測試佐證
- [ ] 前台的寫入端點受跨站請求偽造保護
- [ ] 匿名訪客仍然可以瀏覽商品
