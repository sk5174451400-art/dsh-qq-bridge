/**
 * Official QQ bot transport: AppID + AppSecret → access_token → WebSocket
 * gateway (wss://api.bot.qq.com/websocket/) → C2C private-message events, and
 * REST sending. Protocol implemented from the official docs
 * (bot.q.qq.com/wiki/develop/api-v2/), fetched 2026-08-15:
 *
 * - Token: POST /app/getAppAccessToken, 7200s lifetime, refresh before expiry.
 * - REST auth header: `Authorization: QQBot <access_token>`.
 * - Gateway URL comes from GET /gateway.
 * - WS: Hello (op 10) → Identify (op 2, token inside payload) → READY; then
 *   heartbeat op 1 (d = last sequence or null) / ACK op 11; reconnect with
 *   Resume (op 6) when a session exists.
 * - Private messages arrive as DISPATCH t=C2C_MESSAGE_CREATE; repeated pushes
 *   share msg_id and must be deduplicated by msg_idx.
 * - Sending: POST /v2/users/{user_openid}/messages with an incrementing
 *   msg_seq; a passive reply may carry msg_id + msg_seq.
 *
 * @module @deepseek-ai/dsh-qq-bridge/qq-official
 */

import type { SourceMessage, MessageSource, SourceStatus } from './source.ts'

/** Official REST/API base. */
const API_BASE = 'https://api.bot.qq.com'

/** Token endpoint (docs: api.bot.qq.com/app/getAppAccessToken). */
const TOKEN_URL = `${API_BASE}/app/getAppAccessToken`

/** Gateway discovery endpoint. */
const GATEWAY_URL = `${API_BASE}/gateway`

/** Bot profile endpoint (used by the connection test). */
const ME_URL = `${API_BASE}/users/@me`

/** Private-message intent: GROUP_AND_C2C_EVENT = 1 << 25. */
const INTENT_C2C = 1 << 25

/** Reconnect delay base in milliseconds. */
const DEFAULT_RECONNECT_DELAY_MS = 5000

/** Reconnect backoff ceiling. */
const MAX_RECONNECT_DELAY_MS = 60000

/** How early (ms) before token expiry to refresh. */
const TOKEN_REFRESH_MARGIN_MS = 60_000

/** Credentials for one QQ bot. */
export interface QqCredentials {
  appId: string
  appSecret: string
}

/** Result of {@link testConnection}. */
export interface ConnectionTestResult {
  ok: boolean
  /** Bot display name when the profile fetch succeeded. */
  botName?: string
  /** Failure detail when not ok. */
  error?: string
}

/** Outbound payload shape of a successful send. */
interface SendResponse {
  id?: string
  err_code?: number
  message?: string
}

/** Loose record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Normalize any thrown value to its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetch an access token for the given app credentials.
 * @param credentials - AppID/AppSecret from the QQ open platform.
 * @returns the token and its lifetime in seconds.
 */
export async function fetchAccessToken(credentials: QqCredentials): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.appSecret }),
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || typeof body['access_token'] !== 'string') {
    const code = body['code'] ?? body['err_code'] ?? response.status
    const detail = typeof body['message'] === 'string' ? body['message'] : String(body)
    throw new Error(`QQ token failed (${String(code)}): ${detail}`)
  }
  return {
    accessToken: body['access_token'] as string,
    expiresInSeconds: Number(body['expires_in'] ?? 7200),
  }
}

/**
 * Verify credentials by fetching the bot profile.
 * @param credentials - AppID/AppSecret.
 * @returns ok with the bot name, or the failure detail.
 */
export async function testConnection(credentials: QqCredentials): Promise<ConnectionTestResult> {
  try {
    const { accessToken } = await fetchAccessToken(credentials)
    const response = await fetch(ME_URL, {
      headers: { Authorization: `QQBot ${accessToken}` },
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const code = body['err_code'] ?? response.status
      const detail = typeof body['message'] === 'string' ? body['message'] : String(body)
      return { ok: false, error: `profile failed (${String(code)}): ${detail}` }
    }
    const name = isRecord(body) && typeof body['username'] === 'string' ? body['username'] : undefined
    return name === undefined ? { ok: true } : { ok: true, botName: name }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** WebSocket opcodes per the official protocol. */
const enum Op {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Hello = 10,
  HeartbeatAck = 11,
}

/** Official QQ bot transport over the WebSocket gateway + REST sending. */
export class QqOfficialSource implements MessageSource {
  private ws: WebSocket | undefined
  private stopped = false
  private token: string | undefined
  private tokenExpiresAtMs = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private lastSeq: number | null = null
  private readonly handlers = new Set<(message: SourceMessage) => void | Promise<void>>()
  private readonly statusHandlers = new Set<(status: SourceStatus) => void>()
  private currentStatus: SourceStatus = { state: 'closed', detail: 'not started' }
  private openedAt: number | undefined
  private botName: string | undefined
  private sendSeq = 0
  private readonly recent = new Map<string, number>()

  constructor(
    private readonly credentials: QqCredentials,
    private readonly reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  ) {}

  /** Register an inbound private-message handler. */
  onMessage(handler: (message: SourceMessage) => void | Promise<void>): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  /** Register a connection-status listener. */
  onStatus(listener: (status: SourceStatus) => void): () => void {
    this.statusHandlers.add(listener)
    return () => { this.statusHandlers.delete(listener) }
  }

  /** Current connection state. */
  status(): SourceStatus {
    if (this.openedAt === undefined || this.currentStatus.state !== 'open') return this.currentStatus
    return { ...this.currentStatus, uptimeMs: Date.now() - this.openedAt }
  }

  /** Connect (or reconnect). Idempotent while open. */
  start(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.stopped = false
    void this.connectLoop()
  }

  /** Close permanently; no further reconnects. */
  stop(): void {
    this.stopped = true
    this.clearHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.ws?.close()
    this.ws = undefined
    this.setState({ state: 'closed', detail: 'stopped' })
  }

  /**
   * Send one private message via REST.
   * @param userId - the recipient user_openid.
   * @param text - plain text content.
   */
  async send(userId: string, text: string): Promise<void> {
    const accessToken = await this.ensureToken()
    const msgSeq = ++this.sendSeq
    const body: Record<string, unknown> = {
      content: text,
      msg_type: 0,
      msg_seq: msgSeq,
    }
    const response = await fetch(`${API_BASE}/v2/users/${encodeURIComponent(userId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `QQBot ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({})) as SendResponse
    if (!response.ok || (data.err_code !== undefined && data.err_code !== 0)) {
      throw new Error(`QQ send failed (${String(data.err_code ?? response.status)}): ${data.message ?? 'unknown'}`)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private setState(next: SourceStatus): void {
    this.currentStatus = next
    for (const listener of this.statusHandlers) {
      try { listener(next) } catch { /* contained */ }
    }
  }

  private async ensureToken(): Promise<string> {
    if (this.token !== undefined && Date.now() < this.tokenExpiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
      return this.token
    }
    const { accessToken, expiresInSeconds } = await fetchAccessToken(this.credentials)
    this.token = accessToken
    this.tokenExpiresAtMs = Date.now() + expiresInSeconds * 1000
    return accessToken
  }

  private async gatewayUrl(): Promise<string> {
    const accessToken = await this.ensureToken()
    const response = await fetch(GATEWAY_URL, { headers: { Authorization: `QQBot ${accessToken}` } })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok || typeof body['url'] !== 'string') {
      throw new Error(`gateway discovery failed: ${String(body['message'] ?? response.status)}`)
    }
    return body['url'] as string
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const url = await this.gatewayUrl()
        await this.connect(url)
        this.reconnectAttempts = 0
        return
      } catch (error) {
        if (this.stopped) return
        this.reconnectAttempts++
        const delay = Math.min(this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts - 1, 5), MAX_RECONNECT_DELAY_MS)
        this.setState({ state: 'closed', detail: `${messageOf(error)} (retry in ${delay}ms)` })
        await new Promise(resolve => { this.reconnectTimer = setTimeout(resolve, delay) })
      }
    }
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (error) {
        this.setState({ state: 'closed', detail: `ws create: ${messageOf(error)}` })
        resolve()
        return
      }
      this.ws = ws
      this.setState({ state: 'connecting', detail: url })

      ws.onopen = () => {
        // The gateway answers with Hello; Identify is sent on the first Hello.
      }
      ws.onmessage = (event) => { this.handleFrame(event.data) }
      ws.onerror = () => {
        this.setState({ state: 'connecting', detail: `${url} (socket error)` })
      }
      ws.onclose = (event) => {
        this.clearHeartbeat()
        this.openedAt = undefined
        this.setState({ state: 'closed', detail: `closed code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}` })
        if (!this.stopped) {
          // 4009: resume is preferred; 4914/4915 are terminal (sandbox/ban).
          if (event.code === 4914 || event.code === 4915) {
            this.stopped = true
            this.setState({ state: 'closed', detail: `terminal close ${event.code}${event.reason ? `: ${event.reason}` : ''}` })
            resolve()
            return
          }
        }
        resolve()
      }
    })
  }

  private handleFrame(data: unknown): void {
    let payload: unknown = data
    if (typeof data === 'string') {
      try { payload = JSON.parse(data) } catch { return }
    }
    if (!isRecord(payload)) return
    const op = payload['op']
    if (op === Op.Hello) {
      const d = payload['d']
      const interval = isRecord(d) && typeof d['heartbeat_interval'] === 'number' ? d['heartbeat_interval'] : 30_000
      this.startHeartbeat(interval)
      void this.identify()
      return
    }
    if (op === Op.HeartbeatAck) return
    if (op === Op.Dispatch) {
      const sequence = typeof payload['s'] === 'number' ? payload['s'] : null
      if (sequence !== null) this.lastSeq = sequence
      const type = payload['t']
      const d = payload['d']
      if (type === 'READY' && isRecord(d)) {
        this.openedAt = Date.now()
        const user = isRecord(d['user']) ? d['user'] : undefined
        this.botName = user && typeof user['username'] === 'string' ? user['username'] : undefined
        const base: SourceStatus = {
          state: 'open',
          detail: this.botName ? `connected as ${this.botName}` : 'connected',
          uptimeMs: 0,
        }
        this.setState(this.botName === undefined ? base : { ...base, botName: this.botName })
        return
      }
      if (type === 'C2C_MESSAGE_CREATE' && isRecord(d)) {
        this.handleC2cMessage(d)
        return
      }
      if (type === 'RESUMED') {
        this.openedAt = Date.now()
        this.setState({ state: 'open', detail: 'resumed', uptimeMs: 0 })
        return
      }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({ op: Op.Heartbeat, d: this.lastSeq }))
    }, intervalMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private async identify(): Promise<void> {
    const accessToken = await this.ensureToken().catch(() => undefined)
    if (!accessToken || this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      op: Op.Identify,
      d: {
        token: `QQBot ${accessToken}`,
        intents: INTENT_C2C,
        shard: [0, 1],
        properties: { $os: 'node', $browser: 'dsh-qq-bridge', $device: 'dsh-qq-bridge' },
      },
    }))
  }

  private handleC2cMessage(d: Record<string, unknown>): void {
    const author = isRecord(d['author']) ? d['author'] : undefined
    const userId = author && typeof author['user_openid'] === 'string' ? author['user_openid'] : undefined
    if (!userId) return
    const content = typeof d['content'] === 'string' ? d['content'] : ''
    const messageId = typeof d['id'] === 'string' ? d['id'] : undefined
    // Deduplication: repeated pushes share msg_id; use msg_idx from ext as seq.
    const scene = isRecord(d['message_scene']) ? d['message_scene'] : undefined
    const ext = Array.isArray(scene?.['ext']) ? scene['ext'] as unknown[] : []
    const seq = ext.map(String).find(entry => entry.startsWith('msg_idx='))?.slice('msg_idx='.length)
    const dedupKey = `${messageId ?? ''}:${seq ?? ''}`
    if (dedupKey !== ':') {
      const now = Date.now()
      if (this.recent.has(dedupKey)) return
      this.recent.set(dedupKey, now)
      if (this.recent.size > 500) {
        for (const [key, at] of this.recent) {
          if (now - at > 60_000) this.recent.delete(key)
        }
      }
    }
    const message: SourceMessage = {
      userId,
      text: content,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(seq !== undefined ? { seq } : {}),
    }
    for (const handler of this.handlers) {
      void Promise.resolve(handler(message)).catch(() => { /* contained */ })
    }
  }
}
