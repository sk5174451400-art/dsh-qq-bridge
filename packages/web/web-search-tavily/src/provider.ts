/**
 * Tavily search provider for the dsh-web seam, and a soft router that serves
 * Tavily first and falls back to DeepSeek search when Tavily is unavailable
 * or a search fails.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'

/** Provider id of the plain Tavily search backend. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Provider id of the soft router (Tavily → DeepSeek fallback). */
export const TAVILY_ROUTER_PROVIDER_ID = 'tavily-fallback'

/** Default Tavily API base. */
const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Options one Tavily search is served from (projected per request). */
export interface TavilySearchProviderOptions {
  /** Literal API key; prefer {@link resolveApiKey} so no secret enters config. */
  apiKey?: string
  /** Resolve the API key for each search (credentials/env plane). */
  resolveApiKey?: () => Promise<string | undefined>
  /** API base; defaults to `https://api.tavily.com`. */
  baseURL?: string
  /** `basic` (default) or `advanced`. */
  searchDepth?: 'basic' | 'advanced'
  /** Provider-side result count; the seam enforces the request bound anyway. */
  maxResults?: number
}

/** Loose record guard for decoded JSON payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The Tavily-backed search provider. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - options for the NEXT search, snapshotted once at
   * each search's entry (the settings section may change between searches).
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = options.apiKey ?? (await options.resolveApiKey?.())
    if (!apiKey) {
      throw new WebError('tavily: no API key configured', 'WEB_PROVIDER_ERROR')
    }
    const base = options.baseURL ?? TAVILY_DEFAULT_BASE_URL
    const response = await fetch(`${base}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: request.query,
        search_depth: options.searchDepth ?? 'basic',
        max_results: request.maxResults ?? options.maxResults ?? 5,
        include_answer: true,
      }),
      ...(signal !== undefined ? { signal } : {}),
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const detail = typeof body['message'] === 'string' ? body['message'] : String(body)
      throw new WebError(`tavily: HTTP ${response.status} ${detail}`, 'WEB_PROVIDER_ERROR')
    }
    const results = Array.isArray(body['results']) ? body['results'] : []
    const sources = results
      .filter(isRecord)
      .map(item => {
        const url = typeof item['url'] === 'string' ? item['url'] : ''
        if (url === '') return undefined
        return {
          url,
          ...typeof item['title'] === 'string' && item['title'].length > 0 ? { title: item['title'] as string } : {},
          ...typeof item['content'] === 'string' && item['content'].length > 0 ? { snippet: item['content'] as string } : {},
        }
      })
      .filter((source): source is NonNullable<typeof source> => source !== undefined)
    return {
      ...typeof body['answer'] === 'string' && body['answer'].length > 0 ? { content: body['answer'] as string } : {},
      sources,
      truncated: false,
    }
  }
}

/**
 * A soft router: serves the primary provider first; when it is unavailable or
 * a search fails, tries each fallback in order. Only throws when every
 * provider failed.
 */
export class RouterSearchProvider implements WebSearchProvider {
  readonly id: string

  /**
   * @param id - this router's provider id (pin `searchProvider` to it).
   * @param primary - the preferred provider (e.g. Tavily).
   * @param fallbacks - providers tried in order when the primary fails.
   */
  constructor(
    id: string,
    private readonly primary: WebSearchProvider,
    private readonly fallbacks: readonly WebSearchProvider[],
  ) {
    this.id = id
  }

  available(): boolean {
    return this.primary.available() || this.fallbacks.some(provider => provider.available())
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const chain = [this.primary, ...this.fallbacks].filter(provider => provider.available())
    if (chain.length === 0) {
      throw new WebError('search router: no provider available', 'WEB_PROVIDER_ERROR')
    }
    let lastError: unknown
    for (const provider of chain) {
      try {
        return await provider.search(request, signal)
      } catch (error) {
        lastError = error
      }
    }
    throw new WebError(
      `search router: all providers failed (${lastError instanceof Error ? lastError.message : String(lastError)})`,
      'WEB_PROVIDER_ERROR',
    )
  }
}
