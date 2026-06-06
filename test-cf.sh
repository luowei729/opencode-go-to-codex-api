#!/bin/bash
TOKEN="sk-1bCdIMVyjvI0Ir6ApxqpQqhe32uegAs9mQkvGTxwB3rGJuDxvUSOkxoDJRvpGdgM"
BASE="https://openaiapi.lkz.pub"
PASS=0
FAIL=0

run_test() {
  local name="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    echo "  ✅ $name"
    ((PASS++))
  else
    echo "  ❌ $name — $result"
    ((FAIL++))
  fi
}

echo "=========================================="
echo "  CF Workers 全面测试 ($BASE)"
echo "=========================================="
echo ""

# 1. Health Check
echo "--- 基础端点 ---"
R=$(curl -s --max-time 5 "$BASE/health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
[ "$R" = "ok" ] && run_test "GET /health" "ok" || run_test "GET /health" "got: $R"

# 2. Models List
R=$(curl -s --max-time 10 "$BASE/v1/models" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null)
[ "$R" -gt 0 ] 2>/dev/null && run_test "GET /v1/models (返回 ${R} 个模型)" "ok" || run_test "GET /v1/models" "got: $R"

# 3. Default Model API
R=$(curl -s --max-time 5 "$BASE/api/default-model" | python3 -c "import sys,json; print('ok' if 'runtimeDefault' in json.load(sys.stdin) else 'fail')" 2>/dev/null)
[ "$R" = "ok" ] && run_test "GET /api/default-model" "ok" || run_test "GET /api/default-model" "got: $R"

echo ""
echo "--- Chat Completions API (OpenAI 兼容模型: deepseek-v4-flash) ---"

# 4. Chat Completions Non-Stream
R=$(curl -s --max-time 15 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"reply: OK"}],"stream":false}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); c=d['choices'][0]['message']['content']; print('ok' if c else 'empty')" 2>/dev/null)
[ "$R" = "ok" ] && run_test "POST /v1/chat/completions (non-stream, OpenAI passthrough)" "ok" || run_test "POST /v1/chat/completions non-stream" "got: $R"

# 5. Chat Completions Stream (OpenAI passthrough)
R=$(curl -s -N --max-time 20 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"say hi"}],"stream":true}' | \
  grep -c "data:" 2>/dev/null)
[ "$R" -gt 3 ] 2>/dev/null && run_test "POST /v1/chat/completions (stream, OpenAI passthrough, ${R} chunks)" "ok" || run_test "POST /v1/chat/completions stream" "got ${R} chunks"

# 6. Chat Completions Non-Stream (Anthropic model: qwen3.7-plus)
R=$(curl -s --max-time 20 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"reply: OK"}],"stream":false}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('object')=='chat.completion' else 'fail: '+str(d))" 2>/dev/null)
[ "$R" = "ok" ] && run_test "POST /v1/chat/completions (non-stream, Anthropic→Chat conversion)" "ok" || run_test "POST /v1/chat/completions Anthropic non-stream" "got: $R"

# 7. Chat Completions Stream (Anthropic model)
R=$(curl -s -N --max-time 25 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"say hi"}],"stream":true}' | \
  grep -c "data:" 2>/dev/null)
[ "$R" -gt 2 ] 2>/dev/null && run_test "POST /v1/chat/completions (stream, Anthropic→Chat conversion, ${R} chunks)" "ok" || run_test "POST /v1/chat/completions Anthropic stream" "got ${R} chunks"

echo ""
echo "--- Responses API (Codex 兼容) ---"

# 8. Responses Non-Stream (OpenAI model: gpt-4o → kimi-k2.6)
R=$(curl -s --max-time 20 "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-4o","input":"1+1=?","stream":false}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('status')=='completed' else 'fail: '+str(d.get('error','')))" 2>/dev/null)
[ "$R" = "ok" ] && run_test "POST /v1/responses (non-stream, model=gpt-4o, OpenAI→Responses conversion)" "ok" || run_test "POST /v1/responses non-stream OpenAI" "got: $R"

# 9. Responses Stream (OpenAI model)
R=$(curl -s -N --max-time 25 "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"gpt-4o","input":"say hi","stream":true}' 2>/dev/null)
HAS_CREATED=$(echo "$R" | grep -c "response.created")
HAS_COMPLETED=$(echo "$R" | grep -c "response.completed")
HAS_DELTA=$(echo "$R" | grep -c "response.output_text.delta")
if [ "$HAS_CREATED" -gt 0 ] && [ "$HAS_COMPLETED" -gt 0 ]; then
  run_test "POST /v1/responses (stream, model=gpt-4o, created+delta(${HAS_DELTA})+completed)" "ok"
else
  run_test "POST /v1/responses stream OpenAI" "created=${HAS_CREATED} delta=${HAS_DELTA} completed=${HAS_COMPLETED}"
fi

# 10. Responses Non-Stream (Anthropic model: qwen3.7-plus)
R=$(curl -s --max-time 20 "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"qwen3.7-plus","input":"1+1=?","stream":false}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('status')=='completed' else 'fail: '+str(d.get('error','')))" 2>/dev/null)
[ "$R" = "ok" ] && run_test "POST /v1/responses (non-stream, model=qwen3.7-plus, Anthropic→Responses conversion)" "ok" || run_test "POST /v1/responses non-stream Anthropic" "got: $R"

# 11. Responses Stream (Anthropic model)
R=$(curl -s -N --max-time 30 "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"qwen3.7-plus","input":"say hi","stream":true}' 2>/dev/null)
HAS_CREATED=$(echo "$R" | grep -c "response.created")
HAS_COMPLETED=$(echo "$R" | grep -c "response.completed")
HAS_DELTA=$(echo "$R" | grep -c "response.output_text.delta")
if [ "$HAS_CREATED" -gt 0 ] && [ "$HAS_COMPLETED" -gt 0 ]; then
  run_test "POST /v1/responses (stream, model=qwen3.7-plus, created+delta(${HAS_DELTA})+completed)" "ok"
else
  run_test "POST /v1/responses stream Anthropic" "created=${HAS_CREATED} delta=${HAS_DELTA} completed=${HAS_COMPLETED}"
fi

echo ""
echo "--- 认证测试 ---"

# 12. No token
R=$(curl -s --max-time 5 "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'error' in d else 'fail')" 2>/dev/null)
[ "$R" = "ok" ] && run_test "无 Token 请求返回 401 错误" "ok" || run_test "无 Token 认证" "got: $R"

# 13. Web UI
R=$(curl -s --max-time 5 "$BASE/" | grep -c "OpenCode Go API Proxy")
[ "$R" -gt 0 ] && run_test "GET / Web UI 页面" "ok" || run_test "GET / Web UI" "not found"

echo ""
echo "=========================================="
echo "  测试结果: ✅ ${PASS} 通过 / ❌ ${FAIL} 失败 (共 $((PASS+FAIL)) 项)"
echo "=========================================="
