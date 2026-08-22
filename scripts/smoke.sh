#!/usr/bin/env bash
# 安裝後 smoke test：走完商品、庫存、訂單、付款、Outbox、ERP 與 MCP 三條垂直流程。
# 用法：BASE_URL=http://localhost:3000 ADMIN_TOKEN=... MCP_TOKEN=... scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_TOKEN="${ADMIN_TOKEN:?ADMIN_TOKEN is required}"
MCP_TOKEN="${MCP_TOKEN:-$ADMIN_TOKEN}"
SKU="SMOKE-$(date +%s)-$RANDOM"
PASS=0
FAIL=0

say()  { printf '\n== %s\n' "$1"; }
check() {
  if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; PASS=$((PASS+1));
  else printf '  FAIL %s (expected %s, got %s)\n' "$1" "$3" "$2"; FAIL=$((FAIL+1)); fi
}
jqr() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$1;console.log(v===undefined?'':v)}catch(e){console.log('')}})"; }
api() { # method path body [idempotency-key]
  local method="$1" path="$2" body="${3:-}" key="${4:-}"
  local args=(-sS -o /tmp/smoke_body -w '%{http_code}' -X "$method" "$BASE_URL$path" -H "authorization: Bearer $ADMIN_TOKEN")
  [ -n "$key" ] && args+=(-H "idempotency-key: $key")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}"
}

say "健康檢查"
check "/health/live" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/health/live")" "200"
check "/health/ready" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/health/ready")" "200"
check "/health/dependencies 需要授權" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/health/dependencies")" "401"
check "/health/dependencies（帶 token）" "$(api GET /health/dependencies)" "200"

say "流程一：商品與庫存"
check "未帶 token 會被擋" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/products")" "401"
check "建立商品 (201)" "$(api POST /api/v1/products "{\"sku\":\"$SKU\",\"name\":\"Smoke 測試商品\",\"priceCents\":12500,\"currency\":\"TWD\",\"status\":\"active\"}" "smoke-product-$SKU")" "201"
PRODUCT_ID=$(jqr 'j.data.id' < /tmp/smoke_body)
[ -n "$PRODUCT_ID" ] || { echo "  FAIL 沒有拿到 productId"; exit 1; }
echo "  productId=$PRODUCT_ID"

check "重複 SKU 會衝突" "$(api POST /api/v1/products "{\"sku\":\"$SKU\",\"name\":\"重複\",\"priceCents\":1,\"currency\":\"TWD\"}" "smoke-dup-$SKU")" "409"
check "查詢商品" "$(api GET "/api/v1/products/$PRODUCT_ID")" "200"
check "搜尋商品" "$(api GET "/api/v1/products?q=$SKU")" "200"

ADJ_KEY="smoke-adjust-$SKU"
check "調整庫存 +10" "$(api POST /api/v1/inventory/adjust "{\"productId\":\"$PRODUCT_ID\",\"delta\":10,\"reason\":\"restock\"}" "$ADJ_KEY")" "200"
check "缺少 Idempotency-Key 會被拒" "$(api POST /api/v1/inventory/adjust "{\"productId\":\"$PRODUCT_ID\",\"delta\":5,\"reason\":\"restock\"}")" "400"
check "相同 Idempotency-Key 重放" "$(api POST /api/v1/inventory/adjust "{\"productId\":\"$PRODUCT_ID\",\"delta\":10,\"reason\":\"restock\"}" "$ADJ_KEY")" "200"
api GET "/api/v1/inventory/$PRODUCT_ID" >/dev/null
ON_HAND=$(jqr 'j.data.onHand' < /tmp/smoke_body)
check "重放後庫存仍是 10" "$ON_HAND" "10"
check "同 key 不同內容會被擋" "$(api POST /api/v1/inventory/adjust "{\"productId\":\"$PRODUCT_ID\",\"delta\":99,\"reason\":\"restock\"}" "$ADJ_KEY")" "422"

say "流程二：訂單與付款"
check "建立訂單 (201)" "$(api POST /api/v1/orders "{\"customerEmail\":\"smoke@example.com\",\"lines\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":2}]}" "smoke-order-$SKU")" "201"
ORDER_ID=$(jqr 'j.data.id' < /tmp/smoke_body)
ORDER_NUMBER=$(jqr 'j.data.number' < /tmp/smoke_body)
echo "  orderId=$ORDER_ID number=$ORDER_NUMBER"
api GET "/api/v1/inventory/$PRODUCT_ID" >/dev/null
check "下單後實體庫存仍為 10" "$(jqr 'j.data.onHand' < /tmp/smoke_body)" "10"
check "下單後預留庫存為 2" "$(jqr 'j.data.reserved' < /tmp/smoke_body)" "2"
check "庫存不足會被擋" "$(api POST /api/v1/orders "{\"customerEmail\":\"smoke@example.com\",\"lines\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":999}]}" "smoke-oversell-$SKU")" "409"
check "標記付款" "$(api POST "/api/v1/orders/$ORDER_ID/pay" '{}' "smoke-pay-$SKU")" "200"
check "付款請求進入處理中" "$(jqr 'j.data.status' < /tmp/smoke_body)" "payment_processing"
printf '  等待付款 worker'
PAYMENT_STATUS=""
for _ in $(seq 1 30); do
  api GET "/api/v1/orders/$ORDER_ID" >/dev/null
  PAYMENT_STATUS=$(jqr 'j.data.status' < /tmp/smoke_body)
  [ "$PAYMENT_STATUS" = "paid" ] && break
  printf '.'; sleep 1
done
printf '\n'
check "付款完成後訂單為 paid" "$PAYMENT_STATUS" "paid"
api GET "/api/v1/inventory/$PRODUCT_ID" >/dev/null
check "付款完成後實體庫存扣為 8" "$(jqr 'j.data.onHand' < /tmp/smoke_body)" "8"
check "付款完成後預留庫存清空" "$(jqr 'j.data.reserved' < /tmp/smoke_body)" "0"
check "重複付款是冪等的" "$(api POST "/api/v1/orders/$ORDER_ID/pay" '{}' "smoke-pay-$SKU")" "200"

say "流程三：Extension（Demo ERP 與 MCP）"
printf '  等待 worker 處理 outbox'
DELIVERED=""
for _ in $(seq 1 30); do
  api GET "/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=50" >/dev/null
  DELIVERED=$(jqr "(j.data.items.find(i=>i.orderId==='$ORDER_ID')||{}).status" < /tmp/smoke_body)
  [ "$DELIVERED" = "sent" ] && break
  printf '.'; sleep 1
done
printf '\n'
check "ERP 投遞成功" "$DELIVERED" "sent"
REMOTE_ID=$(jqr "(j.data.items.find(i=>i.orderId==='$ORDER_ID')||{}).remoteId" < /tmp/smoke_body)
[ -n "$REMOTE_ID" ] && { echo "  ok   取得 ERP remoteId=$REMOTE_ID"; PASS=$((PASS+1)); } || { echo "  FAIL 沒有 remoteId"; FAIL=$((FAIL+1)); }

api GET "/api/v1/extensions/demo-erp/queries/ext.demo-erp.inspectDeliveryPayload?orderId=$ORDER_ID" >/dev/null
check "ERP payload inspector 回傳實際 reference" "$(jqr 'j.data.payload.reference' < /tmp/smoke_body)" "SO-$ORDER_NUMBER"
check "ERP payload inspector 使用 ERP 文件格式" "$(jqr 'j.data.payload.documentType' < /tmp/smoke_body)" "SALES_ORDER"
if [ -n "${DEMO_ERP_API_KEY:-}" ]; then
  check "ERP payload inspector 不含 API key" "$(jqr '!JSON.stringify(j.data.payload).includes(process.env.DEMO_ERP_API_KEY)' < /tmp/smoke_body)" "true"
fi

check "人工重送" "$(api POST /api/v1/extensions/demo-erp/commands/ext.demo-erp.resendOrder "{\"orderId\":\"$ORDER_ID\"}" "smoke-resend-$SKU")" "200"
sleep 3
api GET "/api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries?limit=50" >/dev/null
check "重送後遠端 id 不變（沒有重複建單）" "$(jqr "(j.data.items.find(i=>i.orderId==='$ORDER_ID')||{}).remoteId" < /tmp/smoke_body)" "$REMOTE_ID"
check "重送會再次處理 ERP" "$(jqr "(j.data.items.find(i=>i.orderId==='$ORDER_ID')||{}).attempts>=2" < /tmp/smoke_body)" "true"

MCP_CALL() {
  curl -sS -o /tmp/smoke_body -w '%{http_code}' -X POST "$BASE_URL/mcp" \
    -H "authorization: Bearer $MCP_TOKEN" -H 'content-type: application/json' -d "$1"
}
check "MCP initialize" "$(MCP_CALL '{"jsonrpc":"2.0","id":1,"method":"initialize"}')" "200"
check "MCP tools/list" "$(MCP_CALL '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')" "200"
check "MCP 公開 4 個工具" "$(jqr 'j.result.tools.length' < /tmp/smoke_body)" "4"
MCP_CALL "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_order\",\"arguments\":{\"orderNumber\":\"$ORDER_NUMBER\"}}}" >/dev/null
check "MCP get_order 取得同一張訂單" "$(jqr 'j.result.structuredContent.number' < /tmp/smoke_body)" "$ORDER_NUMBER"
MCP_CALL '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_sales_summary","arguments":{}}}' >/dev/null
check "MCP get_sales_summary 有付款訂單" "$(jqr 'j.result.structuredContent.paidOrderCount>0' < /tmp/smoke_body)" "true"
MCP_CALL "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"adjust_inventory\",\"arguments\":{\"productId\":\"$PRODUCT_ID\",\"delta\":3,\"reason\":\"restock\",\"idempotencyKey\":\"smoke-mcp-$SKU\"}}}" >/dev/null
check "MCP adjust_inventory 生效" "$(jqr 'j.result.structuredContent.onHand' < /tmp/smoke_body)" "11"
MCP_CALL "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"adjust_inventory\",\"arguments\":{\"productId\":\"$PRODUCT_ID\",\"delta\":3,\"reason\":\"restock\"}}}" >/dev/null
check "MCP 寫入工具缺 idempotencyKey 會被擋" "$(jqr 'j.result.isError===true' < /tmp/smoke_body)" "true"
MCP_CALL '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"Smoke"}}}' >/dev/null
check "MCP search_products 有結果" "$(jqr 'j.result.structuredContent.total>0' < /tmp/smoke_body)" "true"

# 呼叫端（smoke-docker.sh / smoke-native.sh）先用 CLI 建好帳號才會設這兩個變數。
if [ -n "${SMOKE_USER_EMAIL:-}" ] && [ -n "${SMOKE_USER_PASSWORD:-}" ]; then
  say "後台帳號登入"
  COOKIE_JAR=$(mktemp)
  login() { # password -> http code
    curl -sS -c "$COOKIE_JAR" -o /tmp/smoke_body -w '%{http_code}' -X POST "$BASE_URL/api/v1/auth/login" \
      -H 'content-type: application/json' -d "{\"email\":\"$SMOKE_USER_EMAIL\",\"password\":\"$1\"}"
  }
  check "錯誤密碼被擋" "$(login 'definitely-not-the-password')" "401"
  check "正確帳密登入" "$(login "$SMOKE_USER_PASSWORD")" "200"
  check "登入回應不含 session token" "$(jqr '!JSON.stringify(j.data).includes("commerce_session")' < /tmp/smoke_body)" "true"
  # 以下兩行刻意用子字串比對：cookie 名字在 https 部署上會多一個 `__Host-` 前綴（ADR 0023）。
  check "session cookie 是 HttpOnly" "$(grep -c '^#HttpOnly_.*commerce_session' "$COOKIE_JAR")" "1"

  CSRF=$(awk '/commerce_csrf/{print $7}' "$COOKIE_JAR")
  cookie_call() { # method path [extra header] -> http code
    curl -sS -b "$COOKIE_JAR" -o /tmp/smoke_body -w '%{http_code}' -X "$1" "$BASE_URL$2" \
      -H 'content-type: application/json' -H "idempotency-key: smoke-auth-$SKU-$4" ${3:+-H "$3"} -d '{"productId":"x","delta":1,"reason":"restock"}'
  }
  check "session 可以讀取資料" "$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/products")" "200"
  check "cookie 寫入缺 CSRF token 會被擋" "$(cookie_call POST /api/v1/inventory/adjust '' nocsrf)" "403"
  check "cookie 寫入帶正確 CSRF token 會通過驗證" "$(cookie_call POST /api/v1/inventory/adjust "x-csrf-token: $CSRF" withcsrf)" "400"
  check "/auth/me 回報登入者" "$(curl -sS -b "$COOKIE_JAR" "$BASE_URL/api/v1/auth/me" | jqr 'j.data.email')" "$SMOKE_USER_EMAIL"

  curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null -X POST "$BASE_URL/api/v1/auth/logout" -H "x-csrf-token: $CSRF"
  check "登出後 session 失效" "$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/auth/me")" "401"
  rm -f "$COOKIE_JAR"
fi

say "死信佇列（DLQ）"
check "未帶 token 會被擋" "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/system/jobs/dead")" "401"
check "死信清單可用" "$(api GET /api/v1/system/jobs/dead)" "200"
# 走完happy path後不該有任何死信；有的話代表這次部署真的有工作掛掉。
check "這次流程沒有留下死信" "$(jqr 'j.data.total' < /tmp/smoke_body)" "0"
check "重送不存在的死信會 404" "$(api POST /api/v1/system/jobs/dead/00000000-0000-4000-8000-000000000000/retry '{}' "smoke-dlq-$SKU")" "404"
check "重送缺 Idempotency-Key 會被拒" "$(api POST /api/v1/system/jobs/dead/00000000-0000-4000-8000-000000000000/retry '{}')" "400"

say "自省與 Extension 清單"
check "/api/v1/extensions" "$(api GET /api/v1/extensions)" "200"
check "掛載 3 個 Extension" "$(jqr 'j.data.items.length' < /tmp/smoke_body)" "3"
check "/api/v1/meta/events" "$(api GET /api/v1/meta/events)" "200"
check "7 個版本化事件" "$(jqr 'j.data.items.length' < /tmp/smoke_body)" "7"

printf '\n== 結果：%d 通過，%d 失敗\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
