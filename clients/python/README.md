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

## Daemon 不可达时的行为

dogfood 第 7 次迭代发现：早期版本把 `should_compress` 写死返 True，目的是让 daemon 每个 turn 都能收到消息。结果 daemon 挂了的时候 Hermes 误以为该压缩，按它内置的激进阈值（20K-40K tokens）压一个本来有 1M 上下文窗口的对话。体验比完全不装 Doctor Chaos 还差。

Req 12 把这件事修了。现在的行为：

- **daemon 挂了或没启动**：插件 `should_compress` 返回 False，让 Hermes 完全沿用它内置的压缩判定。插件不会替 Hermes 决定该不该压缩，"装上 Doctor Chaos 永远不比不装更糟"。
- **daemon 可达**：按 `compression_threshold_fraction`（默认 0.75）和当前 model 的 `context_length` 计算阈值。`prompt_tokens >= fraction * context_length` 时才返回 True，触发 Doctor Chaos 走话题空间历史。
- **路由发送到 daemon 走背景队列**：每次 Hermes 调任何生命周期钩子（`compress` / `update_from_response` / `on_session_*`），插件都顺手 flush 一次队列。daemon 不可达时消息留在队列里，恢复后下一个钩子调用时自动补送，用同一个 `idempotency_key` 不会重复路由。
- **可达性缓存**：插件用一个心跳缓存避免每次 `should_compress` 都同步打 daemon。可通过 `health_check_interval`（默认 30 秒）调整探测频率。0 表示每次都探测，适合测试。

队列上限 1000 条，超过时按 FIFO 丢最早的（极少触发，dogfood 一周内还没遇到过）。

## 当前进度（2026-05-29 更新）

**Solution A 已冻结，转向 Solution B（Hermes 上游 RFC）**。

经过 7 次 dogfood 迭代后，得出的判断是：在 Hermes 当前 ContextEngine ABC 下，无法实现 Doctor Chaos 的核心愿景——"消息进来时，先决定它属于哪个话题空间，再用那个空间的历史作为上下文"。当前 ABC 把"上下文选择"和"上下文压缩"压在同一个 `compress()` 钩子上，强迫路由作为压缩的副作用发生，结果是路由永远滞后于压缩一拍。

我们尝试过的所有 in-plugin workaround（包括最初的"`should_compress` 永远返 True"以及现在的"机会式 flush + 心跳缓存"）都只能解决"装了不能比不装更糟"这条产品红线，无法做到"路由先于压缩"这条产品愿景。

下一步：向 Hermes 上游提 RFC，提议把 `select_context()` 从 `compress()` 拆出来。规划文档见 `对话入口范式-开源项目/Hermes-RFC-规划.md`。

在 RFC 有结果之前：
- 这个插件保持当前形态，是已经装机用户的兜底
- 不再继续 dogfood、不再补 Solution A 相关测试、不再升级 Solution A 相关功能
- 任何 Solution A 范畴的 bug 报告，回复"已知限制，等 Solution B"
