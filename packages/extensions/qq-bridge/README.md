# @deepseek-ai/dsh-qq-bridge

QQ 官方机器人桥接插件：让手机 QQ 私聊消息驱动 DSH agent 会话，出门在外也能
继续开发项目。基于 **QQ 开放平台官方机器人 API**（AppID + AppSecret），
经官方 WebSocket 网关收发消息——无第三方协议，无封号风险。

配套界面包：`@deepseek-ai/dsh-client-ui-qq-bridge`（设置页的"QQ 连接"卡片：
填凭证 + 测试连接 + 状态显示）。

## 工作原理

```
手机 QQ ──> QQ 开放平台网关（官方 WebSocket）──> dsh-qq-bridge（host）
      ──> AgentManager：live 会话直接驱动 / 冷会话 resume
      ──> followup ──> whenIdle ──> 提取回复 ──> REST 回发 QQ
```

- **凭证**：QQ 开放平台 AppID + AppSecret（设置卡片里填；Secret 留空不改动已存值）。
- **连接**：`getAppAccessToken` 换 token（7200s 自动刷新）→ `GET /gateway`
  拿网关地址 → WebSocket 连接（Identify 握手 + 心跳）→ 接收 `C2C_MESSAGE_CREATE`
  私聊事件（带 msg_idx 去重）→ REST `POST /v2/users/{openid}/messages` 回发。
- **会话**：每 QQ 用户绑定一个 DSH 会话（storage 持久化）。GUI 正在使用的
  **live 会话可直接驱动**（QQ 与 GUI 同会话协作）；冷会话自动 resume。
- **回复**：超长自动分片（默认 4000 字符/片，带 `(1/n)` 序号）。

## 交互命令（QQ 私聊）

命令统一 `/` 前缀，**任何状态下都识别**（已绑定也不影响）：

| 命令 | 行为 |
|---|---|
| `/mulu` `/目录` | 项目（workspace）列表 → 编号 → 该项目会话列表 → 编号绑定 |
| `/huihua` | 全部会话分组菜单（全局编号） |
| `/huihua 3` | 直接绑定全局第 3 个会话 |
| `/new [目录]` | 新建会话（可指定工作目录） |
| `/link <会话ID>` | 绑定指定会话 |
| `/forget` | 解除绑定 |
| `/help` | 帮助 |

未绑定时的普通文本/数字也会弹出菜单；**绑定后普通文本直接投给 agent**
（要用命令请加 `/`）。

## 会话菜单

按项目分组、全局连续编号：

```
📋 请选择会话（回复序号）：
[deepseek_work]
1. 讲一下，你自己…
2. 新会话标题
[CanvasApp]
3. 项目B的会话
4. 新建会话
```

数据源与 GUI 一致（`workspace.json` 注册表 + `session_projcache.json` 标题），
不解析 zstd 会话日志。

## 配置（GUI 设置卡片）

DSH 设置页 → 插件配置 → **QQ 连接**卡片：

- 应用 ID（AppID）/ 应用密钥（AppSecret，只写不显示）
- 允许的 QQ 用户（逗号分隔，空 = 全部）
- 新会话工作目录
- **测试连接**按钮：host 用当前凭证调 QQ 开放平台验证，结果写回状态行
  （`✅ 已连接（机器人名）` / `❌ 连接失败：原因`）
- 保存：写入 settings 命名空间 `qq-bridge`（变更即重连）

静态默认值（挂载行 `config`）作为 base，GUI 保存值优先。

## 部署（源码 checkout 模式）

依赖组件：
1. **host 插件**：`packages/extensions/qq-bridge` → 挂载行 `qq-bridge`。
2. **设置卡片**：`packages/client/ui-qq-bridge` → 挂载行 `ui-qq-bridge`。
3. **settings 白名单**：`packages/host/apiproxy/src/api-proxy.ts` 的
   `PRODUCT_SETTINGS_NAMESPACES` 已含 `'qq-bridge'`（否则浏览器拿不到配置，
   卡片显示"未加载"）。

```sh
# 仓库根构建
npm run build:lib && npm run build:web
# profile 挂载（cordis.patch.yml）
# - insert:
#     - id: qq-bridge
#       name: '@deepseek-ai/dsh-qq-bridge'
#       config: { appId: '', appSecret: '' }
#     - id: ui-qq-bridge
#       name: '@deepseek-ai/dsh-client-ui-qq-bridge'
# 重启 dsh web 生效
```

## 开发

```sh
pnpm exec tsc -b packages/extensions/qq-bridge           # host 类型检查
pnpm exec tsc -b packages/client/ui-qq-bridge            # client 类型检查
pnpm vitest run packages/extensions/qq-bridge/tests      # 29 项测试
npm run build:lib && npm run build:web                   # 全量构建
```

## 安全与风险

- **密钥**：AppSecret 当前以明文存于 `$DSH_HOME/settings.yaml`；计划迁移到
  DSH 凭据存储（credentials 域，不落明文）——见 DESIGN.md TODO。
- **私聊权限**：`allowedUsers` 白名单建议配置；未授权用户收到拒绝提示。
- agent 会话权限遵循 DSH 部署权限设置（默认 workspace-write）。
- 常驻要求：QQ 桥接依赖本机 DSH 进程在线（关机则离线）。

## 设计文档

见 [DESIGN.md](DESIGN.md)（架构、协议细节、验收清单、TODO）。
