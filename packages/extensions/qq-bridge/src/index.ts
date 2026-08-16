/**
 * @deepseek-ai/dsh-qq-bridge — mount the QQ bridge in a DSH composition.
 *
 * The plugin connects to a OneBot 11 forward WebSocket (NapCat), receives QQ
 * private messages, and drives DSH agent sessions: a session menu for first
 * contact, `/link` / `/new` / `/sessions` / `/forget` / `/help` commands, and
 * reply fan-out with long-message splitting.
 *
 * Connection and policy values are editable in the DSH settings UI (namespace
 * `qq-bridge`); the patch-level plugin config below is the deployment base.
 *
 * @module @deepseek-ai/dsh-qq-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
// Loader-side Context merges for the services this plugin injects.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { QqBridge } from './bridge.ts'
import { Config } from './config.ts'
import type { Config as QqBridgeConfig } from './config.ts'
import { QqOfficialSource, testConnection } from './qq-official.ts'
import type { QqCredentials } from './qq-official.ts'

/** Stable Cordis plugin name. */
export const name = 'qq-bridge'

/** Core services required before the bridge can mount. */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'storageDomain', 'settings']

/** Re-exported for tests, deployment overlays, and the settings UI. */
export { Config, QqBridge, QqOfficialSource, testConnection }
export type { QqBridgeConfig, QqCredentials }

/**
 * Mount the QQ bridge and stop its connection on dispose.
 * @param ctx - plugin context carrying the core services.
 * @param config - validated plugin config (deployment base for settings).
 */
export function apply(ctx: Context, config: QqBridgeConfig): void {
  const bridge = new QqBridge(ctx, config)
  void bridge.start().catch(error => {
    console.warn('[qq-bridge] start failed:', error)
  })
  ctx.effect(() => () => {
    void bridge.dispose()
  })
}
