# StoreWeave 的完成定義。`make verify` 是唯一的完成權威——它非零就是沒做完。
# 規則刻意寫成字面值（沒有變數、沒有 include、沒有續行），ForgeFlow Doctor 會靜態掃這個檔案。
# 每個目標背後的指令定義在 package.json 的 scripts，這裡只包一層。

# 整合測試刻意序列執行，`make -j` 不得讓三套測試並行。
.NOTPARALLEL:

.PHONY: verify typecheck typecheck-admin test test-admin test-integration test-integration-shard-1 test-integration-shard-2

# 五支依序全跑。任一支非零，make 就停在那裡並回傳非零。
# 沒有任何會改寫原始碼的指令進得來——驗證不能靠改檔案換到綠燈。
verify: typecheck typecheck-admin test test-admin test-integration

typecheck:
	pnpm typecheck

typecheck-admin:
	pnpm typecheck:admin

test:
	pnpm test

test-admin:
	pnpm test:admin

test-integration:
	pnpm test:integration

# CI 專用：把 test-integration 切成兩份平行跑，兩份合起來等於 test-integration。
test-integration-shard-1:
	pnpm test:integration --shard=1/2

test-integration-shard-2:
	pnpm test:integration --shard=2/2
