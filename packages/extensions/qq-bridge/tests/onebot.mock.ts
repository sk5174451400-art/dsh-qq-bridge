/**
 * In-process mock of a OneBot 11 forward-WebSocket server (NapCat stand-in)
 * for exercising {@link OneBotClient} without a real QQ service.
 *
 * No third-party dependencies: the mock speaks RFC 6455 itself (HTTP upgrade
 * handshake plus text/close/ping/pong frames) on top of `node:http`, so it
 * runs anywhere Node >= 22 does.
 *
 * The protocol machinery lives in MODULE-LEVEL functions ({@link sendFrame},
 * {@link tryReadFrame}, {@link handleUpgradeRequest}, {@link pumpConnection},
 * {@link handlePayload}); the class only holds state and public API. Inside a
 * class method the same `socket.write` calls trip a TypeScript inference edge
 * ("Type 'Boolean' has no call signatures") that module-level functions do
 * not, so the class deliberately contains no frame/write logic.
 *
 * Usage:
 *
 * ```ts
 * import { MockOneBotServer } from './onebot.mock'
 * import { OneBotClient } from '../src/onebot'
 *
 * const server = new MockOneBotServer()        // or { token: 'secret' }
 * const port = await server.listen()           // 0 = random port
 *
 * const client = new OneBotClient({ wsUrl: `ws://127.0.0.1:${port}` })
 * client.start()
 * await server.waitForClient()                 // handshake done
 *
 * server.pushPrivateMessage({ userId: '12345', text: 'hi' })
 * // client handlers receive { userId: '12345', text: 'hi', rawMessage: 'hi' }
 *
 * await client.sendPrivate('12345', 'hello')   // recorded in server.sent
 * server.closeAll()                            // drop all clients (reconnect test)
 * await server.close()                         // shut the server down
 * ```
 *
 * @module @deepseek-ai/dsh-qq-bridge/tests/onebot.mock
 */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

/** RFC 6455 WebSocket handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A frame the mock parsed out of a client's byte stream. */
interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** Per-connection parser state. */
interface MockConnection {
  socket: Duplex
  buffer: Buffer
  fragments: Buffer[]
}

/** Options for {@link MockOneBotServer}. */
export interface MockOneBotServerOptions {
  /**
   * When set, the handshake must carry `Authorization: Bearer <token>`;
   * anything else is rejected with HTTP 401.
   */
  token?: string
}

/** A `send_msg` the mock recorded. */
export interface MockSentMessage {
  /** `user_id` from the request params (QQ number). */
  userId: number
  /** `message` from the request params: a string as-is, otherwise JSON. */
  message: string
}

/** An API request the mock received. */
export interface MockOneBotRequest {
  action: string
  params: Record<string, unknown>
  echo: string
}

/** Loose record guard for decoded JSON payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Send one server-to-client frame (never masked, as RFC 6455 requires of
 * server frames). `payload` may be a string (encoded as UTF-8) or a Buffer.
 */
function sendFrame(socket: Duplex, opcode: number, payload: Buffer | string): void {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const len = data.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  socket.write(Buffer.concat([header, data]))
}

/**
 * Try to parse one complete frame off the front of the connection buffer.
 * Returns the frame (with the consumed bytes removed from `conn.buffer`) or
 * `undefined` when more bytes are needed.
 */
function tryReadFrame(conn: MockConnection): Frame | undefined {
  const buf = conn.buffer
  if (buf.length < 2) return undefined
  const first = buf[0]!
  const second = buf[1]!
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let len = second & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return undefined
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return undefined
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  let mask: Buffer | undefined
  if (masked) {
    if (buf.length < offset + 4) return undefined
    mask = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return undefined
  let payload = buf.subarray(offset, offset + len)
  if (mask) {
    const unmasked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ mask[i % 4]!
    payload = unmasked
  }
  conn.buffer = buf.subarray(offset + len)
  return { fin, opcode, payload }
}

/**
 * RFC 6455 handshake accept value: SHA-1 of (key + GUID), base64.
 * Kept as a pure module-level function — see {@link writeUpgradeResponse}.
 */
function computeAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/**
 * Write the RFC 6455 101 handshake response. Isolated in its own function:
 * inline, the same call resolves the socket receiver to Boolean under this
 * project's TypeScript configuration, while this function type-checks.
 */
function writeUpgradeResponse(socket: Duplex, accept: string): void {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
}

/** The mutable state the module-level handlers read and write. */
interface MockServerState {
  clients: Set<Duplex>
  waiter: { resolve: () => void; reject: (error: Error) => void } | undefined
  silent: boolean
  token: string | undefined
  requests: MockOneBotRequest[]
  sent: MockSentMessage[]
}

/** Drop one client with a normal close frame (code 1000). */
function dropClient(socket: Duplex): void {
  sendFrame(socket, 0x8, Buffer.from([0x03, 0xe8]))
  socket.end()
}

/**
 * Handle an HTTP upgrade: validate the websocket handshake and optional token,
 * answer 101, then attach the byte pump. Module-level on purpose — see the
 * class JSDoc for the TypeScript inference edge this avoids.
 */
function handleUpgradeRequest(state: MockServerState, req: IncomingMessage, socket: unknown): void {
  // TypeScript 6.0.3 mis-resolves subsequent statements in this function
  // ("Type 'Boolean'/'void' has no call signatures") unless the socket flows
  // as unknown; narrowing it here keeps the body type-safe at runtime.
  const ws = socket as Duplex
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
    ws.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    ws.destroy()
    return
  }
  if (state.token !== undefined && req.headers.authorization !== `Bearer ${state.token}`) {
    ws.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    ws.destroy()
    return
  }
  writeUpgradeResponse(ws, computeAccept(key))
  // setNoDelay is a net.Socket member not present on the Duplex type.
  // Leading semicolon: the previous call ends in `)` and this line starts
  // with `(`, which ASI would chain into one call expression.
  ;(ws as unknown as { setNoDelay(enable: boolean): void }).setNoDelay(true)
  const conn: MockConnection = { socket: ws, buffer: Buffer.alloc(0), fragments: [] }
  state.clients.add(ws)
  if (state.waiter) {
    const waiter = state.waiter
    state.waiter = undefined
    waiter.resolve()
  }
  ws.on('data', (chunk: Buffer) => {
    conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk])
    pumpConnection(state, conn)
  })
  ws.on('close', () => { state.clients.delete(ws) })
  ws.on('error', () => { state.clients.delete(ws) })
}

/** Consume every complete frame currently buffered on one connection. */
function pumpConnection(state: MockServerState, conn: MockConnection): void {
  for (;;) {
    const frame = tryReadFrame(conn)
    if (!frame) return
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (!frame.fin) {
        conn.fragments = [frame.payload]
        continue
      }
      handlePayload(state, conn, frame.payload)
    } else if (frame.opcode === 0x0) {
      conn.fragments.push(frame.payload)
      if (frame.fin) {
        const full = Buffer.concat(conn.fragments)
        conn.fragments = []
        handlePayload(state, conn, full)
      }
    } else if (frame.opcode === 0x9) {
      sendFrame(conn.socket, 0xa, frame.payload)
    } else if (frame.opcode === 0x8) {
      sendFrame(conn.socket, 0x8, frame.payload)
      conn.socket.end()
    }
    // Opcode 0xa (client pong) is ignored.
  }
}

/** Answer one OneBot request frame: record, optionally send_msg, respond. */
function handlePayload(state: MockServerState, conn: MockConnection, payload: Buffer): void {
  let message: unknown
  try { message = JSON.parse(payload.toString('utf8')) } catch { return }
  if (!isRecord(message)) return
  const action = message['action']
  const params = message['params']
  const echo = message['echo']
  if (typeof action !== 'string' || typeof echo !== 'string') return
  const request: MockOneBotRequest = {
    action,
    params: isRecord(params) ? params : {},
    echo,
  }
  state.requests.push(request)
  if (action === 'send_msg' && isRecord(params)) {
    state.sent.push({
      userId: typeof params['user_id'] === 'number' ? params['user_id'] : Number(params['user_id']),
      message: typeof params['message'] === 'string' ? params['message'] : JSON.stringify(params['message']),
    })
  }
  if (state.silent) return
  sendFrame(conn.socket, 0x1, JSON.stringify({ status: 'ok', retcode: 0, data: null, echo }))
}

/**
 * Mock OneBot 11 forward-WebSocket server.
 *
 * Supports: handshake with optional bearer-token check, request/response over
 * `echo` correlation, `send_msg` recording, inbound private-message push,
 * arbitrary event push, silent mode (record requests but never respond — for
 * timeout tests), and connection dropping (for reconnect tests).
 */
export class MockOneBotServer {
  /** Every `send_msg` request, in arrival order. */
  readonly sent: MockSentMessage[] = []
  /** Every API request, in arrival order (including `send_msg`). */
  readonly requests: MockOneBotRequest[] = []

  private readonly http: Server
  private readonly state: MockServerState

  constructor(options: MockOneBotServerOptions = {}) {
    this.state = {
      clients: new Set<Duplex>(),
      waiter: undefined,
      silent: false,
      token: options.token,
      requests: this.requests,
      sent: this.sent,
    }
    this.http = createServer((_req, res) => {
      // Plain HTTP requests are not part of the forward-WS protocol.
      res.writeHead(404).end()
    })
    this.http.on('upgrade', (req, socket) => handleUpgradeRequest(this.state, req, socket))
  }

  /** The port the server is listening on (valid after `listen()`). */
  get port(): number {
    return this.portNumber
  }

  /** Number of currently connected WebSocket clients. */
  get clientCount(): number {
    return this.state.clients.size
  }

  /** Whether the server is in silent mode (requests recorded, never answered). */
  get isSilent(): boolean {
    return this.state.silent
  }

  /** Start listening. `port` defaults to 0 (OS-assigned). Resolves with the actual port. */
  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.http.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.http.off('error', onError)
        resolve()
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(port, '127.0.0.1')
    })
    const address = this.http.address()
    if (address === null || typeof address === 'string') {
      throw new Error('onebot mock: failed to resolve listening port')
    }
    this.portNumber = address.port
    return this.portNumber
  }

  /**
   * Resolve once at least one client has completed the WebSocket handshake.
   * Rejects after `timeoutMs` (default 5000) if no client ever connects.
   */
  waitForClient(timeoutMs = 5000): Promise<void> {
    if (this.state.clients.size > 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.state.waiter = undefined
        reject(new Error(`onebot mock: no client connected within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.state.waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  /**
   * Push a private-message event to every connected client, shaped as NapCat
   * would send it (`post_type=message`, `message_type=private`, text segment,
   * matching `raw_message`).
   */
  pushPrivateMessage(entry: { userId: number | string; text: string }): void {
    const text = entry.text
    const event = {
      post_type: 'message',
      message_type: 'private',
      user_id: Number(entry.userId),
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      self_id: 10001,
      time: Math.floor(Date.now() / 1000),
    }
    this.pushEvent(event)
  }

  /**
   * Push an arbitrary event frame (e.g. a `meta_event` heartbeat, a notice, or
   * a group message) to every connected client. Lets tests assert what the
   * client ignores.
   */
  pushEvent(event: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(event), 'utf8')
    for (const socket of this.state.clients) sendFrame(socket, 0x1, payload)
  }

  /**
   * Toggle silent mode: while silent, incoming requests are recorded in
   * `requests`/`sent` but never answered — the client's `request()` will hang
   * until its own timeout fires. Simulates a wedged NapCat.
   */
  setSilent(silent: boolean): void {
    this.state.silent = silent
  }

  /**
   * Disconnect every connected client with a normal close (code 1000). The
   * server keeps listening, so clients may reconnect.
   */
  closeAll(): void {
    for (const socket of [...this.state.clients]) dropClient(socket)
  }

  /**
   * Disconnect the client at `index` (0-based, in connection order) with a
   * normal close. A no-op when the index is out of range.
   */
  disconnectClient(index: number): void {
    const socket = [...this.state.clients][index]
    if (socket) dropClient(socket)
  }

  /** Stop listening and disconnect all clients. */
  async close(): Promise<void> {
    if (this.state.waiter) {
      const waiter = this.state.waiter
      this.state.waiter = undefined
      waiter.reject(new Error('onebot mock: server closed'))
    }
    for (const socket of [...this.state.clients]) dropClient(socket)
    await new Promise<void>(resolve => {
      this.http.close(() => resolve())
    })
  }

  private portNumber = 0
}
