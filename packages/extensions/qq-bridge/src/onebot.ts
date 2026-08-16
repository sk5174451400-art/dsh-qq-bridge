/**
 * Minimal OneBot 11 client over a forward WebSocket, sufficient for NapCat.
 *
 * Only what the bridge needs: connect with optional `Authorization: Bearer`
 * token, dispatch private-message events, and answer request/response calls
 * (`send_msg`) through the `echo` correlation field. Everything else in the
 * protocol is ignored.
 *
 * Reliability contract:
 * - Every request is bounded by a timeout (default 15s); a timed-out request
 *   rejects without tearing the connection down, and a late response for it is
 *   dropped.
 * - Reconnects use exponential backoff (base 5s, doubling, capped at 60s) and
 *   reset on a successful connection, so a flapping NapCat never triggers a
 *   synchronous retry storm.
 * - Connection lifecycle details (`close` code/reason, WebSocket `error`
 *   message when the runtime provides one) are surfaced through `onStatus`.
 *
 * @module @deepseek-ai/dsh-qq-bridge/onebot
 */

/** Default per-request timeout in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000

/** Default reconnect delay base in milliseconds. */
const DEFAULT_RECONNECT_DELAY_MS = 5000

/** Reconnect backoff ceiling in milliseconds. */
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60000

/** One message segment as OneBot 11 defines it. */
export interface OneBotSegment {
  type: string
  data?: Record<string, unknown>
}

/** A normalized private message event the bridge consumes. */
export interface PrivateMessageEvent {
  /** Sender QQ number as a decimal string. */
  userId: string
  /** Concatenated text of all text segments. */
  text: string
  /** Raw CQ-code message string. */
  rawMessage: string
}

/**
 * Connection lifecycle status for logging or surface display. `detail` is a
 * human-readable string: the endpoint URL for `connecting`, the WebSocket
 * close `code`/`reason` for `closed`, and the underlying error message for
 * `error` when one is available.
 */
export type OneBotStatus = 'connecting' | 'open' | 'closed' | 'error'

/** Options for {@link OneBotClient}. */
export interface OneBotClientOptions {
  /** OneBot forward-WebSocket endpoint, e.g. `ws://127.0.0.1:3001`. */
  wsUrl: string
  /** Optional access token; sent as the `Authorization: Bearer` header. */
  token?: string
  /**
   * Reconnect delay base in milliseconds; the actual delay doubles per failed
   * attempt and is capped by {@link OneBotClientOptions.maxReconnectDelayMs}.
   * Default 5000.
   */
  reconnectDelayMs?: number
  /**
   * Per-request timeout in milliseconds. A request that gets no correlated
   * response within this window rejects; the connection stays up. Default
   * 15000.
   */
  requestTimeoutMs?: number
  /**
   * Ceiling for the exponential reconnect backoff in milliseconds. Default
   * 60000.
   */
  maxReconnectDelayMs?: number
  /**
   * Lifecycle callback: `connecting`/`open`/`closed`/`error` with an optional
   * detail string (see {@link OneBotStatus}).
   */
  onStatus?: (status: OneBotStatus, detail?: string) => void
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Loose record guard for decoded JSON payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Extract the concatenated text of a OneBot message payload: a plain string
 * is returned as-is, an array of segments contributes the `data.text` of every
 * `type === 'text'` segment, and anything else yields an empty string.
 */
export function extractText(message: unknown): string {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    return message
      .map(segment => {
        if (typeof segment === 'string') return segment
        if (isRecord(segment) && segment['type'] === 'text') {
          const data = segment['data']
          if (isRecord(data) && typeof data['text'] === 'string') return data['text']
        }
        return ''
      })
      .join('')
  }
  return ''
}

/**
 * Create a WebSocket, preferring an `Authorization` header when a token is
 * configured. The runtime's WebSocket type only declares protocols as the
 * second argument; undici accepts an options object with `headers`, so the
 * cast is deliberate. Runtimes that reject the options form fall back to a
 * bare connection.
 */
function createWebSocket(url: string, token?: string): WebSocket {
  if (token) {
    try {
      const options = { headers: { Authorization: `Bearer ${token}` } }
      return new WebSocket(url, options as unknown as string[])
    } catch {
      // Options form unsupported by this runtime — connect without a token.
    }
  }
  return new WebSocket(url)
}

/**
 * OneBot 11 forward-WebSocket client with automatic reconnect.
 *
 * Lifecycle: `start()` connects and keeps reconnecting on drops (exponential
 * backoff, reset on success); `stop()` closes permanently. Inbound
 * `post_type=message`/`message_type=private` frames are normalized into
 * {@link PrivateMessageEvent} and fanned out to registered handlers; every
 * other inbound frame (heartbeats, notices, responses with an unknown `echo`)
 * is ignored.
 */
export class OneBotClient {
  private ws: WebSocket | undefined
  private pending = new Map<string, PendingCall>()
  private seq = 0
  private stopped = false
  private reconnectAttempt = 0
  private handlers = new Set<(event: PrivateMessageEvent) => void | Promise<void>>()

  constructor(private readonly options: OneBotClientOptions) {}

  /**
   * Register a private-message handler; returns its disposer. A handler that
   * throws or rejects never breaks other handlers or the socket.
   */
  onMessage(handler: (event: PrivateMessageEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  /**
   * Connect (or reconnect) to the OneBot endpoint. Idempotent: a no-op while a
   * connection is already open or in progress.
   */
  start(): void {
    const state = this.ws?.readyState
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return
    this.stopped = false
    this.connect()
  }

  /** Close the connection permanently; no further reconnects. */
  stop(): void {
    this.stopped = true
    // Reject anything still in flight even when no socket exists to close
    // (e.g. never connected, or already closed).
    this.rejectAll(new Error('onebot: stopped'))
    this.ws?.close()
  }

  /**
   * Send one OneBot API call and await its correlated response.
   *
   * Rejects immediately when the socket is not open, when `ws.send` throws, or
   * when no response arrives within `requestTimeoutMs` (the pending entry is
   * dropped on timeout, so a late response is ignored and the connection is
   * unaffected).
   */
  request<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    const echo = `q${++this.seq}`
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error(`onebot: ws not open (${action})`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`onebot: request timed out after ${timeoutMs}ms (${action})`))
      }, timeoutMs)
      // Never keep the process alive just for an in-flight request timer.
      timer.unref?.()
      this.pending.set(echo, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Send a private message to one QQ user. */
  sendPrivate(userId: string, message: string): Promise<unknown> {
    return this.request('send_msg', {
      message_type: 'private',
      user_id: Number(userId),
      message,
    })
  }

  private connect(): void {
    // Re-entrancy guard: a queued reconnect timer may fire after `stop()`, a
    // manual `start()`, or another timer already dialed — never stack sockets.
    if (this.stopped) return
    const state = this.ws?.readyState
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return
    this.options.onStatus?.('connecting', this.options.wsUrl)
    let ws: WebSocket
    try {
      ws = createWebSocket(this.options.wsUrl, this.options.token)
    } catch (error) {
      this.options.onStatus?.('error', error instanceof Error ? error.message : String(error))
      if (!this.stopped) setTimeout(() => this.connect(), this.reconnectDelay())
      return
    }
    this.ws = ws
    ws.onopen = () => {
      // A successful connection resets the backoff sequence.
      this.reconnectAttempt = 0
      this.options.onStatus?.('open')
    }
    ws.onerror = event => {
      // The WebSocket `error` event carries no detail in most runtimes; report
      // what the environment gives us, falling back to a generic message.
      const message = (event as { message?: string }).message
      this.options.onStatus?.('error', message ?? 'websocket error')
    }
    ws.onclose = event => {
      // Ignore close of a superseded socket (replaced by a newer connect).
      if (this.ws !== ws) return
      const detail = `code=${event.code}` + (event.reason ? ` reason=${event.reason}` : '')
      this.options.onStatus?.('closed', detail)
      this.rejectAll(new Error(`onebot: connection closed (${detail})`))
      if (!this.stopped) setTimeout(() => this.connect(), this.reconnectDelay())
    }
    ws.onmessage = event => { this.handleMessage(event.data) }
  }

  /** Next backoff delay for the current failed-attempt count, then advance. */
  private reconnectDelay(): number {
    const base = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    const max = this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
    const delay = Math.min(base * 2 ** this.reconnectAttempt, max)
    this.reconnectAttempt += 1
    return delay
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error)
    this.pending.clear()
  }

  private handleMessage(data: unknown): void {
    let payload: unknown = data
    if (typeof data === 'string') {
      try { payload = JSON.parse(data) } catch { return }
    }
    if (!isRecord(payload)) return

    // Correlated API response — match by `echo`, drop if unknown (timed out,
    // duplicate, or not ours).
    const echo = payload['echo']
    if (typeof echo === 'string') {
      const call = this.pending.get(echo)
      if (call) {
        this.pending.delete(echo)
        const ok = payload['status'] === 'ok' || payload['retcode'] === 0
        if (ok) call.resolve(payload['data'])
        else call.reject(new Error(`onebot: ${payload['status'] ?? 'error'} for ${String(payload['echo'])}`))
      }
      return
    }

    // Push event: only private messages matter to the bridge. Everything else
    // (meta_event heartbeats, notices, requests, group messages) is ignored.
    if (payload['post_type'] === 'message' && payload['message_type'] === 'private') {
      const userId = String(payload['user_id'] ?? '')
      if (!userId) return
      const event: PrivateMessageEvent = {
        userId,
        text: extractText(payload['message']),
        rawMessage: typeof payload['raw_message'] === 'string' ? payload['raw_message'] : '',
      }
      for (const handler of this.handlers) {
        void Promise.resolve(handler(event)).catch(() => {
          // A handler failure must never break other handlers or the socket.
        })
      }
    }
  }
}
