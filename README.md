# dsh-qq-bridge — QQ 官方机器人桥接插件（DeepSeek Harness）

让**手机 QQ 私聊**驱动 **DSH agent 会话**：出门在外，用 QQ 继续开发项目。
基于 **QQ 开放平台官方机器人 API**（AppID + AppSecret + 官方 WebSocket 网关）——
无第三方协议、无封号风险。附带 **Tavily 搜索 provider + 软路由**（Tavily →
DeepSeek 自动回退）。

```
手机 QQ ──> QQ 官方网关 ──> dsh-qq-bridge ──> DSH agent 会话 ──> 回复回发 QQ
```

## 组件（三个包）

| 包 | 作用 |
|---|---|
| `@deepseek-ai/dsh-qq-bridge` | host 引擎：QQ 网关、会话菜单、消息投递、绑定持久化 |
| `@deepseek-ai/dsh-client-ui-qq-bridge` | 设置页"QQ 连接"卡片：填凭证 + 测试连接 + 状态 |
| `@deepseek-ai/dsh-web-search-tavily` | Tavily 搜索 + 软路由（默认 Tavily，失败回 DeepSeek） |

## 部署（Windows）

**前提**：已安装 DeepSeek Harness（源码 checkout 或 `npx @deepseek-ai/dsh` 安装）。

```powershell
# 1. 克隆本仓库
git clone <本仓库地址>
cd <仓库目录>

# 2. 一键接入（自动：复制包 → 应用 DSH 修改 → junction → 构建）
powershell -ExecutionPolicy Bypass -File install.ps1 -DshPath "D:\Programs\deepseek-harness"
#   （不带 -DshPath 会尝试自动探测）

# 3. 重启 DSH
dsh web   # 或你的启动器
```

> install.ps1 幂等：重复运行安全，不覆盖你的其它配置。

## 配置（全部在 UI，不碰代码）

重启 DSH 后：**设置 → 插件配置 → QQ 连接**

- **应用 ID（AppID）**：QQ 开放平台机器人 AppID
- **应用密钥（AppSecret）**：只写不显示，留空保持原值
- **允许的 QQ 用户**：逗号分隔；留空 = 所有私聊用户
- **新会话工作目录**：默认显示 `D:\Program Files\deepseek_work`，可改
- **测试连接**：验证凭证 → 显示 `✅ 已连接（机器人名）`
- 搜索配置：设置页会出现"Tavily 搜索"卡片（默认走 Tavily，自动回退 DeepSeek）

**QQ 开放平台**：https://q.qq.com 申请机器人拿 AppID/AppSecret。

## 使用（手机 QQ）

| 你发 | 作用 |
|---|---|
| `/mulu` `/目录` | 全部会话菜单（按项目分组、全局编号） |
| `/huihua N`（或直接发数字） | 进入第 N 个会话 |
| `/new [目录]` | 新建会话（默认工作目录） |
| `/link <会话ID>` | 绑定指定会话 |
| `/forget` | 解除绑定 |
| `/help` | 帮助 |

绑定后直接发消息 = 驱动该会话的 agent 干活；切换会话无需解绑。

## 开发 / 测试

```sh
pnpm exec tsc -b packages/extensions/qq-bridge          # host 类型检查
pnpm exec tsc -b packages/client/ui-qq-bridge           # client 类型检查
pnpm vitest run packages/extensions/qq-bridge/tests     # 29 项测试
pnpm vitest run packages/web/web-search-tavily/tests    # 8 项测试
```

## 目录结构

```
packages/
├── extensions/qq-bridge/      # host 引擎（src/bridge.ts 会话逻辑、src/qq-official.ts 协议）
├── client/ui-qq-bridge/       # 设置卡片（折叠式，复用 DSH 卡片组件）
└── web/web-search-tavily/     # Tavily provider + 软路由
install.ps1                    # 一键接入脚本（幂等）
```

## 安全说明

- 所有密钥（AppSecret / Tavily key）**不在本仓库**，由你在设置/凭据里配置。
- agent 会话权限遵循 DSH 部署权限（默认 workspace-write）。
- QQ 桥接依赖本机 DSH 进程在线。

## License

MIT
