# dsh-qq-bridge 设计文档

> 手机 QQ 私聊 → 驱动 DSH agent 会话继续开发项目。QQ 经 NapCat（OneBot 11
> 协议，正向 WebSocket）接入。插件可移植、配置化，部署在本机 Windows
> （NapCat + DSH web profile + 本插件）。

## 1. 架构与消息流

```
手机 QQ ──> NapCat（QQ 协议层，WebUI 扫码登录，暴露 OneBot WS）
              │  post_type=message, message_type=private
              ▼
        src/onebot.ts（OneBotClient：WS 连接/重连/token/事件分发/send_msg）
              │  PrivateMessageEvent { userId, text, rawMessage }
              ▼
        src/bridge.ts（QqBridge：绑定表 / 会话菜单 / 命令 / 投递 / 回发）
              │  ① 查绑定表（storageDomain KV）→ 未绑定则回菜单
              │  ② AgentManager：create 新会话 或 resume 持久化会话
              │  ③ agent.followup(createUserMessage(...))
              │  ④ await agent.whenIdle()
              │  ⑤ 从 session.events 提取 firstSeq 之后的 assistant/message 文本
              ▼
        sendPrivate(userId, 分片后的回复) ──> NapCat ──> 手机 QQ
```

入口：`src/index.ts` 的 `apply(ctx, config)` 装配 OneBotClient + QqBridge。

## 2. 模块职责

| 模块 | 现状 | 职责 |
|---|---|---|
| `src/onebot.ts` | 已实现 | OneBotClient：正向 WS、token(Auth header 带降级)、自动重连、`onMessage` 注册私聊处理器、`sendPrivate`/`request`、`extractText` |
| `src/config.ts` | 已实现 | Config schema：wsUrl、token、allowedUsers、workspaceDir、recentSessionLimit、maxMessageLength、reconnectDelayMs |
| `src/bridge.ts` | 待开发 | QqBridge：绑定表、会话菜单、命令解析、会话生命周期、投递与回发、分片 |
| `src/index.ts` | 待开发 | 插件装配：`export const name = 'qq-bridge'`、`inject = ['agents', 'sessions', 'agentDefaultModel', 'storageDomain']`、`apply` 挂载 |

## 3. 会话生命周期

- **绑定表**：`storageDomain.open({ name: 'qq-bridge' })` → `domain.table('bindings')`，
  key = `qq:<userId>`，value = `{ sessionId: string }`。持久化，重启不丢。
- **活跃句柄表**：进程内 `Map<userId, AgentHandle>`。消息到达：
  1. 句柄存在且 `agent.status === 'idle'` → 直接 `followup`。
  2. 句柄存在但 running → 排队串行（见并发）。
  3. 句柄不存在 → `agents.resume({ resumeSessionId })`；resume 失败
     （会话不存在 / 已 live 被别的句柄占用）→ 回错误消息。
- **sessionId 命名**：新建用 `SessionId(`qq-${userId}-${randomUUID()}`)`；
  绑定既有会话用用户 `/link` 传入的 ID（或菜单选择）。
- **串行化**：每用户一个 promise 链（`chain = chain.then(handle)`），
  同一用户的并发消息按到达顺序逐个驱动，避免 whenIdle 交叉。
- **闲置回收**：句柄持有超过 `idleTtlMs`（默认 30 分钟，M3 实现）后
  `handle.dispose()` 并从活跃表移除；下次消息重新 resume。
  （AgentLoop 每轮结束已持久化事件，dispose 不丢历史。）
- **创建参数**（参照 headless）：
  ```ts
  const selection = ctx.get('agentDefaultModel')!.currentSelection()
  agents.create({
    sessionId,
    meta: { cwd: config.workspaceDir || process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined }),
  })
  ```

## 4. 会话菜单协议

首次消息（未绑定）回复菜单：

```
📋 请选择会话（回复序号）：
1. <标题A>  (session-xxxx)
2. <标题B>  (session-yyyy)
3. 新建会话
或发送 /new 新建，/link <会话ID> 绑定现有会话
```

- **最近会话获取**：扫描 `$DSH_HOME/sessions/<workspace-dir>/` 下 session 子目录，
  按修改时间倒序取 `recentSessionLimit` 个；标题 = 该会话 JSONL 中第一条
  `user/message` 文本的前 40 字（读文件头即可，低成本）；无法读取则只显示 ID。
  （`ctx.sessions.list()` 只含 live 会话，不覆盖重启后的持久化会话，故用目录扫描。）
- **选择解析**：纯数字 → 菜单序号；其余按命令表。
- 绑定成功后回复：`已绑定会话 <id>，直接发消息即可继续开发。`

## 5. 命令协议

| 命令 | 行为 | 回复示例 |
|---|---|---|
| `/new [工作目录]` | 新建会话（可选 cwd 覆盖配置） | `已创建会话 session-xxx` |
| `/link <会话ID>` | 绑定指定会话 | `已绑定会话 <id>` / `会话 <id> 不存在或不可恢复` |
| `/sessions` | 重显会话菜单 | 菜单文本 |
| `/help` | 帮助 | 命令清单 |
| `/forget` | 解除绑定并 dispose 活跃句柄 | `已解除绑定` |
| 其他文本 | 驱动当前绑定会话 | agent 回复 |

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| NapCat 未启动 / WS 断开 | onebot.ts 自动重连（指数退避基础 5s）；bridge 不感知 |
| agent turn 报错（turn/end reason=error） | 回发 `⚠️ agent 出错：<code>: <message>` |
| 空回复（无 assistant 文本） | 回发 `（无文本回复）` |
| 非文本消息（图片等，text 为空） | 回发提示只支持文字 |
| 非白名单用户 | 回发 `未授权的 QQ 用户`，不入绑定流程 |
| 消息过长 | 超过 maxMessageLength 的入参不截断（交给模型），只限制回复分片 |
| resume 失败 | 回发错误并提示 /sessions 或 /new |

## 7. 长文本分片

- 回复按 `maxMessageLength`（默认 4000）切分，每片单独 `sendPrivate`。
- 多片加序号头：`(1/3)` `(2/3)` `(3/3)`。
- 连续发送间隔 300ms，避免触发 QQ 频率限制（M3 细化）。

## 8. 验收标准清单

- [ ] A1 本机无 NapCat 时插件启动不崩，重连日志可见（onStatus）
- [ ] A2 连接 NapCat 后，手机 QQ 私聊任意文本 → 返回会话菜单
- [ ] A3 菜单选择"新建会话" → 创建会话并绑定，下一条消息驱动 agent 并回发回复
- [ ] A4 `/link <已有会话ID>` → 绑定成功，消息驱动该会话（继续上下文）
- [ ] A5 `/sessions`、`/help`、`/forget` 行为符合第 5 节
- [ ] A6 重启 DSH 后绑定不丢（storage 持久化），消息可 resume 原会话
- [ ] A7 回复超过 4000 字符被分片且带序号
- [ ] A8 agent 报错/空回复/非白名单/非文本 各回对应提示
- [ ] A9 同用户连发消息按顺序串行处理，不交叉
- [ ] A10 全链路：手机 QQ 出门在外 → 选择项目会话 → 多轮对话 → agent 在本机继续开发项目

## 9. 里程碑边界

- **M1（最小闭环）**：A2/A3/A8 核心子集——私聊消息 → 新建会话 → agent 回复回发。
  菜单先简化为"自动新建 + 提示 /link 命令"。
- **M2（菜单+绑定）**：A2-A6 全量——菜单、/link、/sessions、/forget、持久化。
- **M3（打磨）**：A7/A9/A10——分片、串行化、闲置回收、错误文案、README/部署文档、测试。

## 10. 最终实现变更（2026-08-15 实测后）

本文件第 1-9 节是最初设计；以下为按官方文档实测后的最终实现差异：

- **连接层**：NapCat/OneBot 路线废弃（官方路线合规无封号风险）。
  改为 QQ 官方机器人 API——AppID/AppSecret → `getAppAccessToken` → `GET /gateway`
  → 官方 WebSocket（Identify+心跳）→ `C2C_MESSAGE_CREATE` 事件（msg_idx 去重）
  → REST 发消息。协议要点见 [README.md](README.md)。
- **命令**：统一 `/` 前缀（`/mulu`、`/huihua [N]`、`/new`、`/link`、`/forget`、
  `/help`），任何状态下都识别（绑定后普通文本才投给 agent）。
- **live 会话直接驱动**：`agents.resume` 拒绝 live 会话；用 `ctx.agents.get(id)`
  拿 live agent 直接 followup（QQ 与 GUI 同会话协作）。
- **会话菜单数据源**：`workspace.json` + `session_projcache.json`（GUI 同款），
  按项目分组 + 全局编号；不解析 zstd 会话日志。
- **设置卡片**：`packages/client/ui-qq-bridge`（client 包）+ apiproxy
  `PRODUCT_SETTINGS_NAMESPACES` 白名单注册 `qq-bridge`；凭证/测试/状态
  走 settings 通道（testCounter 触发 host 测试，无 Remote 侵入）。

## 11. TODO / 后续

- AppSecret 迁移到 credentials 域（避免 settings.yaml 明文）
- 群聊支持（GROUP_AT_MESSAGE_CREATE，intent 1<<30）
- 成员管理（配对码/审批/管理员，参考系统 UI）
- 闲置句柄回收（active handle TTL）

## 代码风格约定（与仓库一致）

4 空格缩进、单引号、无分号、类型显式（satisfies/z 校验）、JSDoc 头注释、
模块级 `@module` 标记。
