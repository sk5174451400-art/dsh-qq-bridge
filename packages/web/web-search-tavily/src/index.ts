/**
 * Register the Tavily search provider and a soft router (Tavily → DeepSeek
 * fallback) in `ctx.web`. Pin `searchProvider` to `tavily-fallback` to make
 * the router the active search backend.
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from '@deepseek-ai/dsh-web-search-deepseek'
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'
import { RouterSearchProvider, TAVILY_ROUTER_PROVIDER_ID, TavilySearchProvider } from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export {
  RouterSearchProvider,
  TAVILY_PROVIDER_ID,
  TAVILY_ROUTER_PROVIDER_ID,
  TavilySearchProvider,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Environment variable naming the Tavily API key. */
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv?: string
  /** API base; defaults to `https://api.tavily.com`. */
  baseURL?: string
  /** `basic` (default) or `advanced`. */
  searchDepth?: 'basic' | 'advanced'
  /** Provider-side result count; the seam enforces the request bound anyway. */
  maxResults?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchDepth: z.union([z.const('basic'), z.const('advanced')]).default('basic'),
  maxResults: z.number().step(1).min(1).default(5),
})

/** Settings namespace carrying this provider's key reference and defaults. */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-tavily')

/**
 * Project one resolved section into the options the Tavily provider serves its
 * next search with. Environment fallbacks stay here rather than in the provider.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveTavilyOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    ...config.baseURL !== undefined ? { baseURL: config.baseURL } : {},
    searchDepth: config.searchDepth ?? 'basic',
    maxResults: config.maxResults ?? 5,
  }
}

/**
 * DeepSeek fallback options for the router: the same defaults the shipped
 * DeepSeek search provider uses, reading `DEEPSEEK_API_KEY`.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @returns options for one search.
 */
function resolveDeepseekOptions(ctx: Context): DeepSeekSearchProviderOptions {
  const apiKeyEnv = credentialRef('DEEPSEEK_API_KEY')
  return {
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: DEEPSEEK_DEFAULT_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
    apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: DEEPSEEK_DEFAULT_MAX_USES,
  }
}

/** Register the Tavily provider and the Tavily→DeepSeek soft router. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  const tavily = new TavilySearchProvider(() => resolveTavilyOptions(ctx, current()))
  ctx.web.registerSearchProvider(tavily)
  ctx.web.registerSearchProvider(new RouterSearchProvider(
    TAVILY_ROUTER_PROVIDER_ID,
    tavily,
    [new DeepSeekSearchProvider(() => resolveDeepseekOptions(ctx))],
  ))
}
