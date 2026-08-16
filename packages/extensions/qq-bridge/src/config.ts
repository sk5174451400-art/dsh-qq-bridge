/**
 * @deepseek-ai/dsh-qq-bridge — plugin config (deployment base for settings).
 *
 * The patch-level config below is the deployment default; a user can override
 * every value in the DSH settings UI (namespace `qq-bridge`).
 *
 * @module @deepseek-ai/dsh-qq-bridge/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Plugin config: the QQ bot credentials base, access policy, and session
 * defaults. Fields with schema defaults are declared required (the default
 * always materializes at validation time).
 */
export interface Config {
  /** QQ open-platform bot AppID (deployment base; settings override it). */
  appId: string
  /** QQ open-platform bot AppSecret (deployment base; settings override it). */
  appSecret: string
  /**
   * QQ user allowlist. When non-empty, only listed users may drive sessions;
   * everyone else receives a notice.
   */
  allowedUsers: string[]
  /**
   * Working directory for NEW sessions. When empty, the process cwd is used.
   * Existing sessions keep their own persisted cwd.
   */
  workspaceDir: string
  /** How many recent sessions the menu lists. Default 5. */
  recentSessionLimit: number
  /**
   * Maximum characters per QQ reply message; longer replies are split.
   * Default 4000.
   */
  maxMessageLength: number
  /** Reconnect delay base in milliseconds for the gateway. Default 5000. */
  reconnectDelayMs: number
  /** Last connection-test result (host-written, read-only in the UI). */
  connectionStatus: string
  /** Test trigger counter (the UI bumps it to request a fresh test). */
  testCounter: number
}

export const Config: z<Config> = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  allowedUsers: z.array(String).default([]),
  workspaceDir: z.string().default(''),
  recentSessionLimit: z.number().default(5),
  maxMessageLength: z.number().default(4000),
  reconnectDelayMs: z.number().default(5000),
  connectionStatus: z.string().default(''),
  testCounter: z.number().default(0),
})
