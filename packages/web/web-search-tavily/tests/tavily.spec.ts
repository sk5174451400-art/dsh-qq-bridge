/**
 * Tests for the Tavily search provider and the Tavily → DeepSeek soft router.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/tests
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { RouterSearchProvider, TavilySearchProvider } from '../src/provider.ts'
import type { WebSearchProvider, WebSearchResult } from '@deepseek-ai/dsh-web'

const originalFetch = globalThis.fetch

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>): void {
  globalThis.fetch = handler as unknown as typeof fetch
}

function stubWebSearchProvider(id: string, result: WebSearchResult): WebSearchProvider {
  return {
    id,
    available: () => true,
    search: async () => result,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('TavilySearchProvider', () => {
  it('maps a Tavily response to the normalized search result', async () => {
    let captured: { url: string; body: string } | undefined
    stubFetch(async (url, init) => {
      captured = { url, body: String(init?.body) }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answer: '答案是 Tavily 生成的摘要',
          results: [
            { title: '第一条', url: 'https://example.com/1', content: '内容一' },
            { url: 'https://example.com/2' },
            { not: 'a source' },
          ],
        }),
      }
    })
    const provider = new TavilySearchProvider(() => ({ apiKey: 'tvly-test' }))
    const result = await provider.search({ query: '你好', maxResults: 2 })

    expect(captured?.url).toBe('https://api.tavily.com/search')
    const body = JSON.parse(captured?.body ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({ api_key: 'tvly-test', query: '你好', max_results: 2, include_answer: true })
    expect(result.content).toBe('答案是 Tavily 生成的摘要')
    expect(result.sources).toEqual([
      { url: 'https://example.com/1', title: '第一条', snippet: '内容一' },
      { url: 'https://example.com/2' },
    ])
    expect(result.truncated).toBe(false)
  })

  it('is unavailable without an API key', () => {
    expect(new TavilySearchProvider(() => ({})).available()).toBe(false)
    expect(new TavilySearchProvider(() => ({ apiKey: 'k' })).available()).toBe(true)
  })

  it('throws a WebError on a non-ok response', async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ message: 'invalid key' }) }))
    const provider = new TavilySearchProvider(() => ({ apiKey: 'bad' }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(WebError)
  })

  it('throws a WebError when no key resolves', async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }))
    const provider = new TavilySearchProvider(() => ({ resolveApiKey: async () => undefined }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/no API key/)
  })
})

describe('RouterSearchProvider', () => {
  it('serves the primary provider when it succeeds', async () => {
    const primary = stubWebSearchProvider('tavily', { sources: [{ url: 'https://tavily' }], truncated: false })
    const fallback = stubWebSearchProvider('deepseek', { sources: [{ url: 'https://deepseek' }], truncated: false })
    const router = new RouterSearchProvider('tavily-fallback', primary, [fallback])
    const result = await router.search({ query: 'q' })
    expect(result.sources[0]?.url).toBe('https://tavily')
  })

  it('falls back when the primary search fails', async () => {
    const primary: WebSearchProvider = {
      id: 'tavily',
      available: () => true,
      search: async () => { throw new WebError('tavily down', 'WEB_PROVIDER_ERROR') },
    }
    const fallback = stubWebSearchProvider('deepseek', { sources: [{ url: 'https://deepseek' }], truncated: false })
    const router = new RouterSearchProvider('tavily-fallback', primary, [fallback])
    const result = await router.search({ query: 'q' })
    expect(result.sources[0]?.url).toBe('https://deepseek')
  })

  it('skips an unavailable primary', async () => {
    const primary: WebSearchProvider = {
      id: 'tavily',
      available: () => false,
      search: async () => { throw new Error('should not run') },
    }
    const fallback = stubWebSearchProvider('deepseek', { sources: [{ url: 'https://deepseek' }], truncated: false })
    const router = new RouterSearchProvider('tavily-fallback', primary, [fallback])
    expect(router.available()).toBe(true)
    const result = await router.search({ query: 'q' })
    expect(result.sources[0]?.url).toBe('https://deepseek')
  })

  it('throws when every provider fails', async () => {
    const failing = (id: string): WebSearchProvider => ({
      id,
      available: () => true,
      search: async () => { throw new WebError(`${id} down`, 'WEB_PROVIDER_ERROR') },
    })
    const router = new RouterSearchProvider('tavily-fallback', failing('a'), [failing('b')])
    await expect(router.search({ query: 'q' })).rejects.toThrow(WebError)
  })
})
