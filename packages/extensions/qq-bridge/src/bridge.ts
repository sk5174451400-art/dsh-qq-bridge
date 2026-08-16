/**
 * The QQ ↔ DSH agent bridge: bindings table, session menu, command routing,
 * message delivery, and reply fan-out.
 *
 * @module @deepseek-ai/dsh-qq-bridge/bridge
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from 'zod'
import type { Config } from './config.ts'
import { QqOfficialSource, testConnection } from './qq-official.ts'
import type { MessageSource, SourceMessage } from './source.ts'
import { connectionChanged, QQ_BRIDGE_SETTINGS_NAMESPACE, QqBridgeSettingsSchema, testRequested } from './settings.ts'
import type { QqBridgeSettings } from './settings.ts'

/** Binding table record: which DSH session one QQ user drives. */
const BINDINGS_SCHEMA = z.object({ sessionId: z.string() })

/** Storage domain holding the QQ user → session bindings. */
const BINDINGS_DOMAIN = defineDomain({
  name: 'qq_bridge',
  version: 0,
  tables: {
    bindings: domainTable<`qq:${string}`, { sessionId: string }>(BINDINGS_SCHEMA),
  },
})

/** Binding table key for one QQ user. */
function keyOf(userId: string): `qq:${string}` {
  return `qq:${userId}`
}

/**
 * Upper bound for `/huihua <n>` ordinals and the full menu: the complete
 * session list, independent of the display limit.
 */
const MAX_SESSION_INDEX = 100

/** Command hint printed under every session menu. */
const MENU_HINT = '命令：/mulu 会话列表 /huihua N 进入 /new 新建 /link 绑定 /forget 解绑 /help'

/** One entry of the recent-session menu. */
export interface RecentSession {
  id: string
  title: string
  /** Owning workspace display title (e.g. `deepseek_work`). */
  workspaceTitle: string
}

/** `workspace.json` storage record (the workspace registry). */
interface WorkspaceRegistry {
  global?: { workspaceIds?: string[]; archivedSessionIds?: string[] }
  tables?: {
    workspaces?: Record<string, { path?: string; title?: string; sessionIds?: string[] }>
  }
}

/** `session_projcache.json` storage record (per-session titles). */
interface SessionProjectionCache {
  tables?: {
    sessions?: Record<string, { identity?: { cwd?: string }; rows?: { title?: { val?: string } } }>
  }
}

/** Best-effort JSON read of one storage file. */
async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** Help text served by `/help`. */
export const HELP_TEXT = [
  '📖 帮助',
  '/mulu / /目录    按项目查看会话',
  '/huihua [编号]    查看会话菜单 / 直接选会话',
  '/new [目录]       新建会话（可指定工作目录）',
  '/link <会话ID>    绑定现有会话',
  '/forget           解除绑定',
  '/help             本帮助',
  '',
  '直接发消息：驱动当前绑定的会话继续开发',
].join('\n')

/** Normalize any thrown value to its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Aggregate the last assistant text and turn outcome of one owned interval. */
function summarizeReply(events: readonly SessionEvent[], firstSeq: number): {
  reply: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
} {
  let reply = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text !== '') reply = text
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { reply, reason }
}

/**
 * Split one reply into QQ-sized chunks. Chunks beyond the first carry a
 * `(i/n)` ordinal prefix; a single chunk is returned untouched.
 */
export function splitMessage(message: string, max: number): string[] {
  if (message.length <= max) return [message]
  const parts: string[] = []
  for (let offset = 0; offset < message.length; offset += max) {
    parts.push(message.slice(offset, offset + max))
  }
  return parts.map((part, index) => `(${index + 1}/${parts.length}) ${part}`)
}

/** Normalize a path for cwd comparison (Windows separators). */
function normPath(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase()
}

/**
 * List sessions grouped by workspace, using the GUI's own storage records
 * (`workspace.json` registry + `session_projcache.json` titles) instead of
 * scanning session directories (whose payloads are zstd-compressed). The
 * workspace containing the process cwd sorts first; others keep registry
 * order. Within a workspace, `sessionIds` are newest-first. Archived sessions
 * are skipped. Best-effort: any failure yields an empty list.
 */
export async function listRecentSessions(limit: number): Promise<RecentSession[]> {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const [registry, proj] = await Promise.all([
    readJsonFile<WorkspaceRegistry>(join(home, 'storages', 'workspace.json')),
    readJsonFile<SessionProjectionCache>(join(home, 'storages', 'session_projcache.json')),
  ])
  const archived = new Set(registry?.global?.archivedSessionIds ?? [])
  const sessions = proj?.tables?.sessions
  const result: RecentSession[] = []
  const cwd = normPath(process.cwd())
  const workspaces = Object.entries(registry?.tables?.workspaces ?? {})
    .sort(([, a], [, b]) => {
      const aCwd = normPath(a.path ?? '') === cwd ? 0 : 1
      const bCwd = normPath(b.path ?? '') === cwd ? 0 : 1
      return aCwd - bCwd
    })
  for (const [, ws] of workspaces) {
    const workspaceTitle = ws.title ?? ws.path ?? ''
    for (const sessionId of ws.sessionIds ?? []) {
      if (archived.has(sessionId)) continue
      result.push({
        id: sessionId,
        title: sessions?.[sessionId]?.rows?.title?.val ?? '',
        workspaceTitle,
      })
      if (result.length >= limit) return result
    }
  }
  return result
}

/**
 * The bridge: receives QQ private messages and drives the bound DSH session.
 * One QQ user maps to one DSH session through the persisted bindings table;
 * live sessions are cached in an in-process handle map so consecutive messages
 * reuse the same agent instead of resuming it.
 *
 * The OneBot connection is owned here and rebuilt when the connection settings
 * (wsUrl/token) change in the settings UI. All policy values are read from the
 * resolved settings (user section over the patch-level `base`).
 */
export class QqBridge {
  private bindings!: KvTable<`qq:${string}`, { sessionId: string }>
  private readonly active = new Map<string, AgentHandle>()
  private readonly chains = new Map<string, Promise<void>>()
  private selection: ModelSelection | undefined
  private settingsScope: SettingsScope<QqBridgeSettings> | undefined
  private resolved: QqBridgeSettings | undefined
  private source: MessageSource | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * Mount the bridge: open the bindings domain, cache the default model
   * selection, register the settings namespace, and connect to OneBot.
   */
  async start(): Promise<void> {
    await this.ctx.get('loader')?.await()
    const domain = await this.ctx.storageDomain.open(BINDINGS_DOMAIN)
    this.bindings = domain.table('bindings')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (defaultModel) {
      this.selection = defaultModel.currentSelection()
    }
    this.ctx.inject(['settings'], (settingsCtx) => {
      this.settingsScope = settingsCtx.settings.register(
        settingsNamespace(QQ_BRIDGE_SETTINGS_NAMESPACE),
        QqBridgeSettingsSchema,
        { base: this.config },
      )
      this.resolved = this.settingsScope.get()
      this.applyConnection()
      settingsCtx.on('settings/updated', (namespace) => {
        if (namespace !== QQ_BRIDGE_SETTINGS_NAMESPACE) return
        if (!this.settingsScope) return
        const next = this.settingsScope.get()
        const reconnect = this.resolved !== undefined && connectionChanged(this.resolved, next)
        const runTest = this.resolved !== undefined && (reconnect || testRequested(this.resolved, next))
        this.resolved = next
        if (reconnect) this.reconnect()
        if (runTest) void this.runConnectionTest()
      })
    })
  }

  /** (Re)create the message source from the resolved settings and connect. */
  private applyConnection(): void {
    const resolved = this.resolved
    if (!resolved) return
    if (!resolved.appId || !resolved.appSecret) {
      console.warn('[qq-bridge] AppID/AppSecret not configured; connect to QQ bot via settings')
      return
    }
    const source = new QqOfficialSource(
      { appId: resolved.appId, appSecret: resolved.appSecret },
      this.config.reconnectDelayMs,
    )
    source.onMessage(event => { void this.enqueue(event) })
    source.onStatus?.(status => {
      console.warn(`[qq-bridge] ${status.state}${status.detail ? `: ${status.detail}` : ''}`)
    })
    source.start()
    this.source = source
  }

  /** Tear the connection down and reconnect with the current settings. */
  private reconnect(): void {
    this.source?.stop()
    this.applyConnection()
  }

  /** Resolved policy values: the settings user section over the patch base. */
  private policy(): QqBridgeSettings {
    return this.resolved ?? this.config
  }

  /** Send one private message; a disconnected source drops it silently. */
  private async send(userId: string, message: string): Promise<void> {
    await this.source?.send(userId, message)
  }

  /** Stop the message source; called on plugin dispose. */
  dispose(): void {
    this.source?.stop()
    this.source = undefined
  }

  /**
   * Verify the configured credentials against the QQ open platform and write
   * the outcome into the settings `connectionStatus` field, which the settings
   * card displays.
   */
  private async runConnectionTest(): Promise<void> {
    const resolved = this.resolved
    if (!resolved || !resolved.appId || !resolved.appSecret) {
      await this.settingsScope?.update({ connectionStatus: '未配置 AppID/AppSecret' })
      return
    }
    const result = await testConnection({ appId: resolved.appId, appSecret: resolved.appSecret })
    const status = result.ok
      ? `✅ 已连接${result.botName ? `（${result.botName}）` : ''}`
      : `❌ 连接失败：${result.error ?? '未知错误'}`
    await this.settingsScope?.update({ connectionStatus: status })
  }

  /** Queue one event on the user's serial chain so concurrent messages never interleave. */
  private enqueue(event: SourceMessage): void {
    const previous = this.chains.get(event.userId) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {
        // process() already reported the failure to QQ; keep the chain alive.
      })
    this.chains.set(event.userId, next)
    void next.finally(() => {
      if (this.chains.get(event.userId) === next) this.chains.delete(event.userId)
    })
  }

  /** Route one normalized private message: allowlist, commands, menu, or delivery. */
  private async process(event: SourceMessage): Promise<void> {
    const { userId, text } = event
    const policy = this.policy()
    if (policy.allowedUsers.length > 0 && !policy.allowedUsers.includes(userId)) {
      await this.send(userId, '未授权的 QQ 用户，无法使用本机器人。')
      return
    }
    const trimmed = text.trim()
    if (trimmed === '') {
      await this.send(userId, '目前只支持文字消息，请发送文字。')
      return
    }
    if (trimmed.startsWith('/')) {
      await this.command(userId, trimmed)
      return
    }
    // Plain-language menu command (no slash).
    if (trimmed === '目录' || trimmed === '项目') {
      await this.showMenu(userId)
      return
    }
    const binding = this.bindings.get(keyOf(userId))
    if (binding) {
      await this.deliver(userId, trimmed)
      return
    }
    if (/^\d+$/.test(trimmed)) {
      await this.selectGlobal(userId, Number(trimmed))
      return
    }
    await this.showMenu(userId)
  }

  /** Serve one slash command. */
  private async command(userId: string, line: string): Promise<void> {
    const [command, ...rest] = line.split(/\s+/)
    switch (command) {
      case '/help':
        await this.send(userId, HELP_TEXT)
        break
      case '/new':
        await this.createAndBind(userId, rest[0])
        break
      case '/link': {
        const sessionId = rest[0]
        if (!sessionId) {
          await this.send(userId, '用法：/link <会话ID>')
          break
        }
        try {
          const branded = SessionId(sessionId)
          const live = this.ctx.agents.get(branded)
          if (live) {
            // A live session cannot be resumed, but it can be bound and driven.
            this.releaseActive(userId)
            await this.bindings.put(keyOf(userId), { sessionId })
            await this.send(userId, `已绑定会话 ${sessionId}（正在使用中），直接发消息即可继续开发。`)
            break
          }
          this.releaseActive(userId)
          const selection = this.currentSelection()
          const handle = await this.ctx.agents.resume({
            resumeSessionId: branded,
            ...(selection ? {
              setup: agentCtx => {
                installModelSelection(agentCtx, { current: selection, assembled: undefined })
              },
            } : {}),
          })
          this.active.set(userId, handle)
          await this.bindings.put(keyOf(userId), { sessionId })
          await this.send(userId, `已绑定会话 ${sessionId}，直接发消息即可继续开发。`)
        } catch (error) {
          await this.send(userId, `会话 ${sessionId} 无法恢复（${messageOf(error)}），发送 /sessions 查看可用的会话。`)
        }
        break
      }
      case '/sessions':
        await this.showMenu(userId)
        break
      case '/mulu':
      case '/目录':
      case '/项目':
      case '/workspaces':
        // The full grouped session menu is reachable from any state.
        await this.showMenu(userId)
        break
      case '/huihua': {
        // `/huihua` shows the grouped session menu; `/huihua <n>` binds the
        // n-th session of the FULL session list directly (global ordinal,
        // not limited by how many rows the menu prints).
        const argument = rest[0]
        const index = argument === undefined ? Number.NaN : Number(argument)
        if (argument !== undefined && Number.isInteger(index) && index > 0) {
          await this.selectGlobal(userId, index, MAX_SESSION_INDEX)
        } else {
          await this.showMenu(userId)
        }
        break
      }
      case '/forget': {
        this.releaseActive(userId)
        await this.bindings.delete(keyOf(userId))
        await this.send(userId, '已解除绑定。')
        break
      }
      default:
        await this.send(userId, `未知命令 ${command}，发送 /help 查看帮助。`)
    }
  }

  /** Bind the ordinal of the full grouped session list (global numbering). */
  private async selectGlobal(userId: string, index: number, limit = this.policy().recentSessionLimit): Promise<void> {
    const recent = await listRecentSessions(limit)
    if (index >= 1 && index <= recent.length) {
      const session = recent[index - 1]
      if (session) {
        await this.bindSession(userId, session)
        return
      }
    } else if (index === recent.length + 1) {
      await this.createAndBind(userId)
      return
    }
    await this.send(userId, '序号无效，请重新发送 /huihua 查看菜单。')
  }

  /** Persist a binding and confirm to the user with a human-friendly label. */
  private async bindSession(userId: string, session: RecentSession): Promise<void> {
    // Switching sessions must not reuse the previous session's cached handle.
    this.releaseActive(userId)
    await this.bindings.put(keyOf(userId), { sessionId: session.id })
    const label = session.title === ''
      ? `${session.workspaceTitle === '' ? '' : `${session.workspaceTitle} / `}${session.id}`
      : `${session.workspaceTitle} / ${session.title}`
    await this.send(userId, `已绑定会话：${label}，直接发消息即可继续开发。`)
  }

  /** Release any cached agent handle a user owns (session switch / unbind). */
  private releaseActive(userId: string): void {
    const handle = this.active.get(userId)
    if (handle) {
      this.active.delete(userId)
      void handle.dispose().catch(() => {})
    }
  }

  /**
   * The default model selection, cached once it resolves; re-reads the
   * `agentDefaultModel` service as a fallback so a late-booting service never
   * leaves a fresh session without the `{{model}}` persona variable.
   */
  private currentSelection(): ModelSelection | undefined {
    if (this.selection !== undefined) return this.selection
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (defaultModel) {
      this.selection = defaultModel.currentSelection()
      return this.selection
    }
    return undefined
  }

  /** Create a fresh session, bind it, and cache its live handle. */
  private async createAndBind(userId: string, cwd?: string): Promise<void> {
    const selection = this.currentSelection()
    try {
      const sessionId = SessionId(`qq-${userId}-${randomUUID()}`)
      const workspace = cwd || this.policy().workspaceDir || process.cwd()
      this.releaseActive(userId)
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: workspace },
        ...(selection ? {
          agentOptions: { provider: selection.provider, model: selection.model },
        } : {}),
        setup: agentCtx => {
          if (selection) installModelSelection(agentCtx, { current: selection, assembled: undefined })
        },
      })
      this.active.set(userId, handle)
      await this.bindings.put(keyOf(userId), { sessionId: String(sessionId) })
      await this.send(userId, `已创建并绑定会话 ${sessionId}（工作目录：${workspace}），直接发消息即可开始。`)
    } catch (error) {
      await this.send(userId, `创建会话失败：${messageOf(error)}`)
    }
  }

  /** Send the full grouped session menu: every project, every session, one global ordinal list. */
  private async showMenu(userId: string): Promise<void> {
    const recent = await listRecentSessions(MAX_SESSION_INDEX)
    if (recent.length === 0) {
      await this.send(userId, '还没有任何会话。发送 /new 新建一个。')
      return
    }
    const lines = ['📋 会话列表（回复 /huihua <编号> 进入，或直接回复编号）：']
    let lastWorkspace = ''
    recent.forEach((session, index) => {
      if (session.workspaceTitle !== lastWorkspace) {
        lastWorkspace = session.workspaceTitle
        lines.push(`[${lastWorkspace}]`)
      }
      lines.push(`${index + 1}. ${session.title === '' ? session.id : session.title}`)
    })
    lines.push(`${recent.length + 1}. 新建会话`)
    lines.push(MENU_HINT)
    await this.send(userId, lines.join('\n'))
  }

  /** Drive the bound session with one user message and fan the reply out. */
  private async deliver(userId: string, text: string): Promise<void> {
    const binding = this.bindings.get(keyOf(userId))
    if (!binding) {
      await this.showMenu(userId)
      return
    }
    const sessionId = SessionId(binding.sessionId)
    // A live agent (e.g. the session open in the GUI right now) is driven
    // directly — resume cannot restore an already-live session.
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      await this.drive(userId, live, text)
      return
    }
    let handle = this.active.get(userId)
    if (!handle) {
      const selection = this.currentSelection()
      try {
        handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          // A resumed agent must get the model-selection injection too, or the
          // `{{model}}` persona variable has no value for this assembly.
          ...(selection ? {
            setup: agentCtx => {
              installModelSelection(agentCtx, { current: selection, assembled: undefined })
            },
          } : {}),
        })
      } catch (error) {
        this.active.delete(userId)
        const detail = messageOf(error)
        const hint = detail.includes('while it is live')
          ? '该会话正在 GUI 中使用，稍后重试。'
          : `发送 /sessions 或 /new 重新选择。`
        await this.send(userId, `会话 ${binding.sessionId} 无法恢复（${detail}），${hint}`)
        return
      }
      this.active.set(userId, handle)
    }
    await this.drive(userId, handle.agent, text)
  }

  /** Run one turn on an agent and send the resulting reply to QQ. */
  private async drive(userId: string, agent: Agent, text: string): Promise<void> {
    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const { reply, reason } = summarizeReply(agent.session.events, firstSeq)
      if (reason?.kind === 'error') {
        await this.send(userId, `⚠️ agent 出错：${reason.error.code}: ${reason.error.message}`)
      } else if (reply === '') {
        await this.send(userId, '（无文本回复）')
      } else {
        for (const chunk of splitMessage(reply, this.policy().maxMessageLength)) {
          await this.send(userId, chunk)
        }
      }
    } catch (error) {
      await this.send(userId, `驱动会话失败：${messageOf(error)}`)
    }
  }
}
