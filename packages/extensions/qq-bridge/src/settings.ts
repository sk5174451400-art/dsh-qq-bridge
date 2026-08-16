/**
 * Runtime settings namespace for the QQ bridge: the connection and policy
 * values a user edits in the DSH settings UI. The patch-level plugin config
 * serves as the `base` (deployment default); the user section overrides it.
 *
 * @module @deepseek-ai/dsh-qq-bridge/settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace registered on `ctx.settings`. */
export const QQ_BRIDGE_SETTINGS_NAMESPACE = 'qq-bridge'

/** The settings document a user can edit in the GUI settings page. */
export interface QqBridgeSettings {
  /** QQ open-platform bot AppID. */
  appId: string
  /** QQ open-platform bot AppSecret. Stored locally; never displayed. */
  appSecret: string
  /** QQ user allowlist; empty allows every private-message sender. */
  allowedUsers: string[]
  /** Working directory for NEW sessions; empty falls back to the process cwd. */
  workspaceDir: string
  /** How many recent sessions the menu lists. */
  recentSessionLimit: number
  /** Maximum characters per QQ reply message. */
  maxMessageLength: number
  /**
   * Last connection-test result, written by the host bridge: a human-readable
   * line like `已连接（测试）` or `连接失败：...`. Read-only in the UI.
   */
  connectionStatus: string
  /**
   * Test trigger: the settings UI bumps this counter to request a fresh
   * connection test from the host bridge (a same-value settings update does
   * not emit `settings/updated`, so the counter forces the event).
   */
  testCounter: number
}

export const QqBridgeSettingsSchema: z<QqBridgeSettings> = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  allowedUsers: z.array(String).default([]),
  workspaceDir: z.string().default(''),
  recentSessionLimit: z.number().default(5),
  maxMessageLength: z.number().default(4000),
  connectionStatus: z.string().default(''),
  testCounter: z.number().default(0),
})

/** Detect whether a connection-relevant field changed between two snapshots. */
export function connectionChanged(previous: QqBridgeSettings, next: QqBridgeSettings): boolean {
  return previous.appId !== next.appId || previous.appSecret !== next.appSecret
}

/** Detect whether a fresh connection test was requested by the settings UI. */
export function testRequested(previous: QqBridgeSettings, next: QqBridgeSettings): boolean {
  return next.testCounter !== previous.testCounter
}
