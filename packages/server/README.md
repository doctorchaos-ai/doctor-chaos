# @doctorchaos-ai/server

Doctor Chaos 的 HTTP daemon。把 `@doctorchaos-ai/core` 里的 `Clinic` 类包成一个 localhost HTTP 服务，让非 TypeScript 的 agent（Hermes、其他 Python 工具、以后的 Go / Rust / Swift 客户端）都能通过一根薄线协议驱动话题路由。

> **alpha 不是免责声明，是承诺。** 现在只支持 localhost 绑定、无认证、单租户；URL 里的 `tenant_id` 段永远是 `default`。系统性的升级计划在 spec 仓库的 `deferred-requirements.md` 里排队。

## 安装与启动

```bash
# 工程内开发
pnpm --filter @doctorchaos-ai/server build
node packages/server/dist/cli.cjs start

# 全局装完以后（v0.2 以后发 npm）
npm install -g @doctorchaos-ai/server
doctor-chaos-server start
```

命令行选项：

```
doctor-chaos-server start [--port N] [--host H] [--snapshot PATH]
                          [--routing-mode auto|llm|embedding|keyword]
                          [--llm-base-url URL] [--llm-api-key KEY]
                          [--llm-model NAME]   [--llm-format openai-compat|anthropic]
```

- `--port N`：监听端口（默认 `18790`，env: `DOCTOR_CHAOS_PORT`）
- `--host H`：绑定主机（默认 `127.0.0.1`，loopback）
- `--snapshot PATH`：快照文件路径（默认 `~/.doctorchaos/tenants/default/snapshot.json`）
- `--routing-mode M`：路由档位（默认 `auto`）
  - `auto` —— 有合法的 LLM 配置就走 LLM；否则降级 embedding；都没有才 keyword
  - `llm` —— 强制 LLM 直接路由
  - `embedding` —— 强制嵌入相似度（**只认 `OPENAI_API_KEY`**）
  - `keyword` —— 零依赖兜底
- `--llm-*`：显式 LLM 配置，覆盖 env

## Doctor Chaos 不挑厂商

Doctor Chaos 不做厂商枚举。LLM 档位由**一组项目自有配置**驱动，指向任何 OpenAI-compatible 端点或 Anthropic 原生端点都行：

```bash
export DOCTOR_CHAOS_LLM_BASE_URL=https://api.deepseek.com/v1
export DOCTOR_CHAOS_LLM_API_KEY=sk-xxx
export DOCTOR_CHAOS_LLM_MODEL=deepseek-chat
# 可选，默认 openai-compat；如果点 Anthropic 的 /v1/messages 原生 API 就设 anthropic
export DOCTOR_CHAOS_LLM_FORMAT=openai-compat
```

**这组 env 适用于所有主流厂商**：

| 厂商 / 网关 | BASE_URL | 推荐 MODEL | FORMAT |
|-----|----------|-----------|--------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `openai-compat` |
| Anthropic（原生） | `https://api.anthropic.com/v1` | `claude-3-5-haiku-20241022` | `anthropic` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | `openai-compat` |
| Kimi / Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | `openai-compat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `openai-compat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `openai-compat` |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-Text-01` | `openai-compat` |
| 豆包 / Ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-1-5-pro-32k-250115` | `openai-compat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` 或 `anthropic/claude-3.5-haiku`（300+ 模型任选，带厂商前缀） | `openai-compat` |
| LiteLLM 代理 | 你的代理地址（如 `http://localhost:4000`） | 代理里 `config.yaml` 注册的任意 `model_name` | `openai-compat` |
| OneAPI / New API 代理 | 你的代理地址（如 `http://localhost:3000/v1`） | 代理后台配置的渠道模型名 | `openai-compat` |
| Ollama（本地） | `http://localhost:11434/v1` | `llama3.2` / `qwen2.5:7b` / `deepseek-r1:7b` 等本机已 pull 的模型 | `openai-compat` |
| LM Studio（本地） | `http://localhost:1234/v1` | LM Studio 里已加载的模型名（在 UI 右上角可看到） | `openai-compat` |

**配置优先级**（高到低）：

1. CLI `--llm-*` flags
2. `DOCTOR_CHAOS_LLM_*` env vars
3. `OPENAI_API_KEY`（+ 可选 `OPENAI_BASE_URL`、`OPENAI_MODEL`）—— 唯一的厂商特定回落，因为 OpenAI 的 env 约定是事实标准，大部分用户已经有了

> **设计说明**：之前版本尝试过探测 8 个厂商的 API key 名，这个路子在实现初期被否了。原因：枚举必然不全；命名会变；本地模型和代理没有"厂商 key"；用户的路由 LLM 不一定跟主 agent 用同一家。显式配置干净得多。

优雅停机：`SIGINT` / `SIGTERM`，默认 5 秒 grace。

## HTTP 接口

所有 Clinic 相关接口都挂在 `/v1/tenants/{tenant_id}/...` 前缀下。当前 `tenant_id` 只支持 `default`。

| Method | Path | 作用 |
|--------|------|------|
| `GET`  | `/v1/health` | 存活检查，无需认证 |
| `POST` | `/v1/tenants/{tenant_id}/messages` | 路由一条消息 |
| `GET`  | `/v1/tenants/{tenant_id}/spaces` | 列话题空间（支持 `?status=active,dormant`） |
| `GET`  | `/v1/tenants/{tenant_id}/spaces/{space_id}` | 取单个话题空间（含完整消息） |
| `GET`  | `/v1/tenants/{tenant_id}/inbox` | 取 inbox |
| `POST` | `/v1/tenants/{tenant_id}/packaging/check` | 触发打包评估 |
| `POST` | `/v1/tenants/{tenant_id}/lifecycle/check` | 触发生命周期评估 |
| `POST` | `/v1/tenants/{tenant_id}/messages/{message_id}/move` | 移动一条消息 |

每个响应都带两个 header：

- `X-Request-Id`：请求 id，出现在日志里，贴进 issue 很方便
- `X-DoctorChaos-Version`：当前 daemon 版本

### 错误响应

所有错误返回统一形状：

```json
{
  "code": "space_not_found",
  "message": "Space 'xyz' not found.",
  "request_id": "req-..."
}
```

错误码词汇表：

| HTTP | code | 触发条件 |
|------|------|---------|
| 400  | `bad_request` | 请求 body 缺字段、schema 不合法、非 JSON Content-Type |
| 404  | `tenant_not_found` | `tenant_id` 不是 `default` |
| 404  | `space_not_found` | 指定的 space id 不存在 |
| 404  | `message_not_found` | 指定的 message id 在 tenant 内不存在 |
| 500  | `internal_error` | Clinic 抛了未捕获异常（body 里不带 stack，日志里有） |

## Idempotency

所有写端点（`POST /messages`、`packaging/check`、`lifecycle/check`、`messages/:id/move`）都接受一个可选的 `idempotency_key` 字段。在同一个进程生命周期内、10 分钟 TTL 内、相同 key 的重复请求会直接返回第一次的响应，不会重复路由 / 重复打包。

**已知限制**：这个 idempotency cache **不跨进程重启**。如果 A2 dogfood 期间撞到，升级为持久化——这个在 `deferred-requirements.md` 里记账了。

## 持久化

每次写操作成功后，daemon 把 `Clinic.snapshot()` 完整写到磁盘：

- 策略：`write-through after mutation`
- 原子性：先写 `snapshot.json.tmp`，再 `rename`
- 格式：JSON，Date 用 ISO 8601 字符串

重启时从快照加载。快照文件不存在时正常 cold-start；**快照文件存在但解析失败时 daemon 拒绝启动**——比静默扔掉状态更安全。

## 使用建议

- 本包设计目标是被 `doctorchaos_hermes`（Python 客户端）以及未来的语言客户端调用。直接 curl 也没问题，但你要自己处理重试 / 降级。
- 如果 daemon 崩了或没启动，任何合规客户端都应该**降级**而不是挂起用户。
- 这是 alpha 版本。接口在 A1 和 A2 期间可能小幅调整；`/v1` 前缀保证不会发生 wire protocol 破坏性变更。

## 开发

```bash
pnpm --filter @doctorchaos-ai/server dev       # tsup --watch
pnpm --filter @doctorchaos-ai/server test      # vitest run
pnpm --filter @doctorchaos-ai/server typecheck # tsc --noEmit
```
