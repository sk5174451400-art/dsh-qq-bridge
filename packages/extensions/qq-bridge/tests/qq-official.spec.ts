/**
 * Tests for the official QQ bot transport: token fetch, connection test,
 * the WebSocket state machine (Hello → Identify → READY → events), message
 * deduplication, and REST sending.
 *
 * @module @deepseek-ai/dsh-qq-bridge/tests/qq-official
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAccessToken, QqOfficialSource, testConnection } from '../src/qq-official.ts'
import type { SourceMessage } from '../src/source.ts'

const CREDENTIALS = { appId: '1905431383', appSecret: 'secret' }

/** Minimal fake WebSocket class driven by the test. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | undefined
  onmessage: ((event: { data: unknown }) => void) | undefined
  onerror: ((event: unknown) => void) | undefined
  onclose: ((event: { code: number; reason: string }) => void) | undefined

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: '' })
  }

  /** Test helper: push a server frame. */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>): void {
  globalThis.fetch = handler as unknown as typeof fetch
}

function stubWebSocket(): void {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  FakeWebSocket.instances = []
}

function resetStubs(): void {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
}

afterEach(() => {
  resetStubs()
  vi.restoreAllMocks()
})

/** Drive a fresh source through Hello → Identify → READY and return its socket. */
async function connectReady(source: QqOfficialSource): Promise<FakeWebSocket> {
  stubFetch(async (url) => {
    if (url.includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: '7200' }) }
    }
    return { ok: true, status: 200, json: async () => ({ url: 'wss://api.bot.qq.com/websocket/' }) }
  })
  stubWebSocket()
  source.start()
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
  const ws = FakeWebSocket.instances[0]!
  ws.emit({ op: 10, d: { heartbeat_interval: 45000 } })
  ws.emit({ op: 0, s: 1, t: 'READY', d: { session_id: 'sid', user: { id: '1', username: '测试机器人', bot: true } } })
  return ws
}

describe('fetchAccessToken', () => {
  it('posts appId/clientSecret and parses string expires_in', async () => {
    let captured: { url: string; body: string } | undefined
    stubFetch(async (url, init) => {
      captured = { url, body: String(init?.body) }
      return { ok: true, status: 200, json: async () => ({ access_token: 'abc', expires_in: '7200' }) }
    })
    const result = await fetchAccessToken(CREDENTIALS)
    expect(result).toEqual({ accessToken: 'abc', expiresInSeconds: 7200 })
    expect(captured?.url).toBe('https://api.bot.qq.com/app/getAppAccessToken')
    expect(JSON.parse(captured?.body ?? '{}')).toEqual({ appId: '1905431383', clientSecret: 'secret' })
  })

  it('throws with the API error detail on failure', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ code: 100016, message: 'invalid appid or secret' }) }))
    await expect(fetchAccessToken(CREDENTIALS)).rejects.toThrow(/invalid appid or secret/)
  })
})

describe('testConnection', () => {
  it('reports ok and the bot name on success', async () => {
    stubFetch(async (url) => {
      if (url.includes('getAppAccessToken')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: '7200' }) }
      }
      return { ok: true, status: 200, json: async () => ({ id: '1', username: '我的机器人' }) }
    })
    const result = await testConnection(CREDENTIALS)
    expect(result).toEqual({ ok: true, botName: '我的机器人' })
  })

  it('reports the failure detail on bad credentials', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ code: 100016, message: 'invalid appid or secret' }) }))
    const result = await testConnection(CREDENTIALS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid appid or secret')
  })
})

describe('QqOfficialSource', () => {
  it('connects, identifies with QQBot token, and reports open with the bot name', async () => {
    stubFetch(async (url) => {
      if (url.includes('getAppAccessToken')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: '7200' }) }
      }
      if (url.includes('/gateway')) {
        return { ok: true, status: 200, json: async () => ({ url: 'wss://api.bot.qq.com/websocket/' }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    stubWebSocket()
    const source = new QqOfficialSource(CREDENTIALS)
    const statuses: string[] = []
    source.onStatus?.(status => { statuses.push(status.state) })
    source.start()

    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
    const ws = FakeWebSocket.instances[0]!
    ws.emit({ op: 10, d: { heartbeat_interval: 45000 } })
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0))
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({
      op: 2,
      d: { token: 'QQBot tok', intents: 1 << 25, shard: [0, 1] },
    })

    ws.emit({ op: 0, s: 1, t: 'READY', d: { session_id: 'sid', user: { id: '1', username: '测试机器人', bot: true } } })
    await vi.waitFor(() => expect(source.status().state).toBe('open'))
    expect(source.status().botName).toBe('测试机器人')
    expect(source.status().uptimeMs).toBeTypeOf('number')
  })

  it('delivers C2C messages with user_openid and deduplicates repeats', async () => {
    const source = new QqOfficialSource(CREDENTIALS)
    const ws = await connectReady(source)
    const received: SourceMessage[] = []
    source.onMessage(message => { received.push(message) })

    const frame = {
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'ROBOT1.0_msg1',
        author: { id: 'A1', user_openid: 'OPENID_1', username: 'u', bot: false },
        content: '你好',
        message_type: 0,
        message_scene: { source: 'default', ext: ['msg_idx=IDX1'] },
        timestamp: '2026-07-21T10:00:00+08:00',
      },
    }
    ws.emit(frame)
    ws.emit(frame) // repeated push, same msg_idx
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({ userId: 'OPENID_1', text: '你好', messageId: 'ROBOT1.0_msg1' })
  })

  it('reconnects automatically after the socket closes', async () => {
    const source = new QqOfficialSource(CREDENTIALS, 50)
    const statuses: string[] = []
    source.onStatus?.(status => { statuses.push(status.state) })
    const ws = await connectReady(source)
    const firstCount = FakeWebSocket.instances.length
    expect(statuses).toContain('open')

    // Dropping the socket must not leave the bot offline: the connect loop
    // loops around and opens a fresh connection.
    ws.close()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(firstCount))
    expect(statuses).toContain('closed')
  })

  it('sends private messages via REST with QQBot auth and incrementing msg_seq', async () => {
    const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    stubFetch(async (url, init) => {
      if (url.includes('getAppAccessToken')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: '7200' }) }
      }
      const headers = new Headers(init?.headers)
      sent.push({
        url,
        auth: headers.get('Authorization'),
        body: JSON.parse(String(init?.body)),
      })
      return { ok: true, status: 200, json: async () => ({ id: 'ROBOT1.0_out1', timestamp: '2026-07-21T10:00:00+08:00' }) }
    })
    stubWebSocket()
    const source = new QqOfficialSource(CREDENTIALS)
    await source.send('OPENID_2', '第一条')
    await source.send('OPENID_2', '第二条')

    expect(sent).toHaveLength(2)
    expect(sent[0]?.url).toContain('/v2/users/OPENID_2/messages')
    expect(sent[0]?.auth).toBe('QQBot tok')
    expect(sent[0]?.body).toMatchObject({ content: '第一条', msg_type: 0, msg_seq: 1 })
    expect(sent[1]?.body).toMatchObject({ msg_seq: 2 })
  })

  it('surfaces send failures with the err_code message', async () => {
    stubFetch(async (url) => {
      if (url.includes('getAppAccessToken')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: '7200' }) }
      }
      return { ok: false, status: 400, json: async () => ({ err_code: 40034005, message: '回复消息msg_id已过期' }) }
    })
    const source = new QqOfficialSource(CREDENTIALS)
    await expect(source.send('OPENID_3', 'hi')).rejects.toThrow(/回复消息msg_id已过期/)
  })
})
