# doctorchaos-hermes

Python 客户端 + Hermes `ContextEngine` 插件，对接 `@doctorchaos-ai/server` 这个本地 HTTP daemon。

> **alpha 不是免责声明，是承诺。** 目前 daemon 是 localhost-only、无 auth、单租户。 Python 客户端和插件也都是按这个姿态写的。系统性的升级清单在 spec 仓库的 `deferred-requirements.md` 里排队，每 7 天 review 一次。

## 它是什么

两个交付物打成一个 wheel：

1. **`DoctorChaosClient`** —— 一个薄 HTTP 客户端。把 daemon 的每个端点翻译成一个 Python 方法，把传输错误翻译成 Python 异常，把响应翻译成 dataclass。
2. **`DoctorChaosContextEngine`** —— 一个 Hermes `ContextEngine` 合规插件，内部用上面那个客户端。

组合关系：Doctor Chaos 做**话题间路由**，你的 Hermes agent 一个 turn 进来时，插件先让 daemon 把每条新消息分到对应的话题空间，然后取出 focus 空间的完整历史喂给模型。如果你配了 `sub_engine`（比如 `lcm`、`smart-context-engine`），空间内的压缩交给它；没配就按时间尾部截断。

## 装起来

**最简单的方式：把 `INSTALL_VIA_AGENT.md` 里的那段提示词丢给你的 Hermes / OpenClaw / Claude Desktop**。它会自己帮你跑完下面这些步骤，遇到环境问题会停下来问你。

手动装的话：

```bash
# 1. 起 daemon（见 packages/server/README.md）
doctor-chaos-server start

# 2. 装 Python 包
pip install doctorchaos-hermes  # 未发 PyPI 期间：pip install -e /path/to/clients/python

# 3. 拷 plugin.yaml 到你的 Hermes 插件目录
cp plugin.yaml ~/.hermes/plugins/context_engine/doctor_chaos/

# 4. 在 Hermes config.yaml 里切换 context engine
#    context:
#      engine: doctor-chaos
#      doctor_chaos:
#        base_url: http://127.0.0.1:18790
```

这个流程以后会被一条 `pipx install doctorchaos-hermes && doctorchaos-hermes bootstrap` 取代（见 deferred D4）。现在的阶段是手装或让 agent 帮你装。

## 客户端用法

```python
from doctorchaos_hermes import DoctorChaosClient, SpaceNotFound

with DoctorChaosClient() as client:
    result = client.send_message(role="user", content="想想京都周末怎么安排")
    if result.destination == "topicSpace":
        print(result.space.name, result.is_new_space)
        space = client.get_space(result.space.id)
        print([m.content for m in space.messages])

    # 纠正：把一条消息移到另一个空间
    try:
        client.move_message(message_id="m1", to_space_id="s1")
    except SpaceNotFound as err:
        print(err.message, err.request_id)
```

关键行为：

- **自动 idempotency key**：所有写方法（`send_message`、`check_packaging`、`check_lifecycle`、`move_message`）在你没传 `idempotency_key` 时会自动生成一个 UUID，所以天然安全重试。
- **类型化异常**：
  - `DaemonUnreachable` / `DaemonConnectionRefused` / `DaemonDnsFailure` / `DaemonTimeout` — 传输层
  - `BadRequest` / `TenantNotFound` / `SpaceNotFound` / `MessageNotFound` — 4xx
  - `DaemonServerError` — 5xx
- **typed dataclass 响应**：`Message` / `Fragment` / `TopicSpace` / `SpaceSummary` / `Inbox` / `RoutingDecision` / `SendMessageResult`。
- **时间字段**是 `datetime`（UTC 带 tzinfo）。

## 插件用法

配置 Hermes 的 `context.engine: "doctor-chaos"` 以后，所有 `compress` 调用都会走这条链：

1. 把 Hermes 这一 turn 看到的新消息 flush 给 daemon
2. 根据 `focus_topic`（或按 recency）选定一个话题空间
3. 拉这个空间的完整历史
4. 如果配了 `sub_engine` → 交给它做空间内压缩；否则按 `current_tokens` 尾部截断

**降级**：daemon 不可达 / 5xx 重试耗尽时，插件返回 Hermes 原消息数组不变（passthrough），让 Hermes 走自己的默认压缩。每个降级窗口只打一条 warning，不刷屏。

**嵌套子引擎**（组合而非替代）：

```yaml
context:
  engine: doctor-chaos
  doctor_chaos:
    sub_engine: lcm          # 任一已安装的 ContextEngine 插件名
```

有子引擎时，`on_session_*` / `update_from_response` / `get_tool_schemas` / `handle_tool_call` 全都转发给它。这样像 `lcm_grep` 这种依赖子引擎工具的功能仍然可用。

## 已知限制（A0 + A1 阶段）

- **单租户**：daemon 目前只接受 `tenant_id="default"`，客户端默认值已经是它。
- **URL 路径**：`/packaging/check`、`/lifecycle/check`、`/messages/<id>/move` 用 `/` 分隔子动作而不是 `:` 冒号，因为 Hermes 所在的 Hono 路由器不支持冒号当 literal。客户端已经处理这个差异，手 curl 时注意路径。
- **端点覆盖**：daemon 当前接口是 `send`、`list_spaces`、`get_space`、`get_inbox`、`check_packaging`、`check_lifecycle`、`move_message`、`health`。导出快照、多租户、token auth 这些都在 deferred 清单里。

## 开发

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests
```

端到端测试会起一个真实 daemon 子进程，需要先 `pnpm --filter @doctorchaos-ai/server build` 过一次。

## 设计原则（给想看内部的人）

1. **一个方法对应一个 daemon 端点**。不搞 retry-forever、不搞跨 tenant pool。callers 需要这些行为自己在外面包。
2. **类型化异常优于状态码**。调用方永远不需要自己解析 HTTP。
3. **idempotency key 默认生成**。naive 的 try/retry 就是安全的。
4. **降级静默恢复**。一次出问题打一次 warning，回到可达状态不打日志。
