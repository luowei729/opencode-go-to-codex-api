# OpenCode Go API to Codex API Proxy

将 OpenCode Go API 转换为 Codex (OpenAI 兼容) API 格式的代理服务。

## 功能特性

- 将 Codex CLI / OpenAI SDK 的请求转发到 OpenCode Go API
- 支持流式响应 (SSE)
- 支持认证透传或服务器端配置
- Docker 一键部署
- 健康检查端点

## 支持的模型

| 模型 | 模型 ID |
|------|---------|
| GLM-5.1 | glm-5.1 |
| GLM-5 | glm-5 |
| Kimi K2.5 | kimi-k2.5 |
| Kimi K2.6 | kimi-k2.6 |
| DeepSeek V4 Pro | deepseek-v4-pro |
| DeepSeek V4 Flash | deepseek-v4-flash |
| MiMo-V2.5 | mimo-v2.5 |
| MiMo-V2.5-Pro | mimo-v2.5-pro |
| MiniMax M3 | minimax-m3 |
| MiniMax M2.7 | minimax-m2.7 |
| MiniMax M2.5 | minimax-m2.5 |
| Qwen3.7 Max | qwen3.7-max |
| Qwen3.7 Plus | qwen3.7-plus |
| Qwen3.6 Plus | qwen3.6-plus |

## 快速开始

### 1. 获取 OpenCode Go Token

访问 https://opencode.ai/auth 登录并获取你的 API Token。

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
PORT=3000
UPSTREAM_BASE_URL=https://opencode.ai/zen/go
OPENCODE_TOKEN=your_token_here
```

### 3. Docker 部署（推荐）

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

### 4. 直接运行

```bash
npm install
npm start
```

## 使用方法

### 配置 Codex CLI

```bash
# 设置 API 端点指向本地代理
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=your_opencode_token  # 或在 .env 中配置 OPENCODE_TOKEN

# 使用 codex
codex
```

### 使用 OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your_opencode_token"  # 如果服务端已配置，可填任意值
)

response = client.chat.completions.create(
    model="kimi-k2.6",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### 使用 curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_opencode_token" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /v1/models` | 获取可用模型列表 |
| `POST /v1/chat/completions` | 聊天补全（支持流式） |

## 认证方式

代理服务支持两种认证方式：

1. **服务端配置**：在 `.env` 中设置 `OPENCODE_TOKEN`，所有请求自动使用该 Token
2. **客户端透传**：不设置 `OPENCODE_TOKEN`，客户端通过 `Authorization: Bearer <token>` 传递

服务端配置的 Token 优先级高于客户端传递的 Token。

## 架构

```
Codex CLI / OpenAI SDK
        |
        v
┌─────────────────┐
│  Proxy Server   │  :3000
│  (this service) │
└────────┬────────┘
         |
         v
┌─────────────────────────┐
│  OpenCode Go API        │
│  opencode.ai/zen/go/v1  │
└─────────────────────────┘
```

## License

MIT
