/**
 * Integration tests for {@link OneBotClient} against the in-process mock of a
 * OneBot 11 forward-WebSocket server.
 *
 * @module @deepseek-ai/dsh-qq-bridge/tests/onebot
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractText, OneBotClient } from '../src/onebot.ts'
import type { OneBotStatus, PrivateMessageEvent } from '../src/onebot.ts'
import { MockOneBotServer } from './onebot.mock'

const FAST_RECONNECT = 100

const servers: MockOneBotServer[] = []
const clients: OneBotClient[] = []

/** Wait until the client reports the given lifecycle status. */
async function waitForStatus(target: OneBotStatus, statuses: string[]): Promise<void> {
  await vi.waitFor(() => expect(statuses).toContain(target))
}

async function setup(options: {
  token?: string
  clientToken?: string
  reconnectDelayMs?: number
  requestTimeoutMs?: number
} = {}): Promise<{
  server: MockOneBotServer
  client: OneBotClient
  statuses: string[]
}> {
  const server = new MockOneBotServer({ ...(options.token !== undefined ? { token: options.token } : {}) })
  servers.push(server)
  const port = await server.listen(0)
  const statuses: string[] = []
  const client = new OneBotClient({
    wsUrl: `ws://127.0.0.1:${port}`,
    ...(options.clientToken !== undefined ? { token: options.clientToken } : {}),
    reconnectDelayMs: options.reconnectDelayMs ?? FAST_RECONNECT,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    onStatus: status => { statuses.push(status) },
  })
  clients.push(client)
  return { server, client, statuses }
}

afterEach(async () => {
  for (const client of clients) client.stop()
  clients.length = 0
  for (const server of servers) await server.close().catch(() => {})
  servers.length = 0
})

describe('OneBotClient', () => {
  it('receives private message events with extracted text', async () => {
    const { server, client } = await setup()
    const received: PrivateMessageEvent[] = []
    client.onMessage(event => { received.push(event) })
    client.start()
    await server.waitForClient()

    server.pushPrivateMessage({ userId: 12345, text: '你好' })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toEqual({ userId: '12345', text: '你好', rawMessage: '你好' })
  })

  it('sends private messages through the request/response correlation', async () => {
    const { server, client, statuses } = await setup()
    client.start()
    await server.waitForClient()
    await waitForStatus('open', statuses)

    await client.sendPrivate('12345', 'hello')
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0]).toEqual({ userId: 12345, message: 'hello' })
  })

  it('surfaces handshake rejection as closed without a matching token', async () => {
    const { server } = await setup({ token: 'secret' })
    const statuses: string[] = []
    const client = new OneBotClient({
      wsUrl: `ws://127.0.0.1:${server.port}`,
      reconnectDelayMs: 5000,
      onStatus: status => { statuses.push(status) },
    })
    clients.push(client)
    client.start()

    await waitForStatus('closed', statuses)
    expect(server.clientCount).toBe(0)
  })

  it('connects when the client presents the configured token', async () => {
    const { server, client, statuses } = await setup({ token: 'secret', clientToken: 'secret' })
    client.start()
    await waitForStatus('open', statuses)
    expect(server.clientCount).toBe(1)
  })

  it('reconnects automatically after the server drops every client', async () => {
    const { server, client } = await setup()
    client.start()
    await server.waitForClient()

    server.closeAll()
    // The drop is async: wait until the server sees the disconnect, then the
    // client reconnects on its own (fast backoff configured above).
    await vi.waitFor(() => expect(server.clientCount).toBe(0))
    await server.waitForClient()
    expect(server.clientCount).toBe(1)
  })

  it('ignores non-private events such as heartbeats', async () => {
    const { server, client } = await setup()
    const received: PrivateMessageEvent[] = []
    client.onMessage(event => { received.push(event) })
    client.start()
    await server.waitForClient()

    server.pushEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 0 })
    server.pushEvent({ post_type: 'message', message_type: 'group', user_id: 1, group_id: 2, message: [] })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(received).toHaveLength(0)
  })

  it('times out requests the server never answers', async () => {
    const { server, client, statuses } = await setup({ requestTimeoutMs: 300 })
    client.start()
    await waitForStatus('open', statuses)

    server.setSilent(true)
    await expect(client.request('send_msg', { message_type: 'private', user_id: 1, message: 'x' }))
      .rejects.toThrow(/timeout|timed out/i)
  })
})

describe('extractText', () => {
  it('returns plain strings untouched', () => {
    expect(extractText('hello')).toBe('hello')
  })

  it('concatenates text segments and skips non-text segments', () => {
    expect(extractText([
      { type: 'text', data: { text: 'a' } },
      { type: 'image', data: { file: 'x.png' } },
      { type: 'text', data: { text: 'b' } },
    ])).toBe('ab')
  })

  it('handles string segments and malformed input', () => {
    expect(extractText(['x', { type: 'text', data: { text: 'y' } }])).toBe('xy')
    expect(extractText(null)).toBe('')
    expect(extractText(42)).toBe('')
    expect(extractText([{ type: 'text', data: {} }])).toBe('')
  })
})
