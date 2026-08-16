/**
 * QQ bridge settings card controller: binds the `qq-bridge` settings
 * namespace and exposes the card snapshot plus form actions. The connection
 * test is a settings counter bump — the host bridge listens for it, verifies
 * the credentials against the QQ open platform, and writes the outcome into
 * `connectionStatus`, which this card then displays. No Host Remote surface
 * is involved, so the card needs no api-remotes dependency.
 *
 * @module @deepseek-ai/dsh-client-ui-qq-bridge/client/controller
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, numberField, textField } from './card-form.ts'
import type { CardActions, CardFieldSpec, CardFieldState, CardShell } from './card-form.ts'

/** The `qq-bridge` settings section as this card edits it. */
export interface QqBridgeSettingsSection {
  appId: string
  appSecret: string
  allowedUsers: string[]
  workspaceDir: string
  recentSessionLimit: number
  maxMessageLength: number
  connectionStatus: string
  testCounter: number
}

/** Snapshot the card renders. */
export interface QqBridgeCardState extends CardShell {
  appId: CardFieldState
  appSecret: CardFieldState
  allowedUsers: CardFieldState
  workspaceDir: CardFieldState
  /** Whether the section carries a stored secret (write-only, never rendered). */
  appSecretConfigured: boolean
  /** Host-reported connection-test outcome line. */
  connectionStatus: string
}

/** Actions the card's slot entry injects. */
export interface QqBridgeCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useQqBridgeCard. */
    qqBridgeCard: SnapshotStore<QqBridgeCardState>
  }
  /** Bump the test counter; the host bridge runs the connection test. */
  testConnection(): Promise<void>
}

/**
 * A comma-separated list field (the QQ user allowlist): formats an array as
 * comma-joined text and parses back into a trimmed, non-empty array.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function listField(field: string): CardFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.join(',') : '',
    parse: (text) => ({
      kind: 'set',
      value: text.split(',').map(entry => entry.trim()).filter(entry => entry !== ''),
    }),
  }
}

/** Bridges the `qq-bridge` settings scope onto the card. */
export class QqBridgeCardController {
  private readonly form: CardForm<QqBridgeSettingsSection>
  private readonly store: SnapshotStore<QqBridgeCardState>

  constructor(private readonly scope: SettingsScope<QqBridgeSettingsSection>) {
    this.form = new CardForm(
      scope,
      [
        textField('appId'),
        listField('allowedUsers'),
        textField('workspaceDir'),
        numberField('recentSessionLimit'),
        numberField('maxMessageLength'),
      ],
      [
        // The secret is stored inside the section (unlike a credentials-domain
        // key); a blank draft writes nothing, keeping the stored value.
        { field: 'appSecret', write: async (text) => {
          if (text === '') return true
          await scope.set('appSecret', text)
          return true
        } },
      ],
    )
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): QqBridgeCardState {
    const value = this.scope.getSnapshot().value
    return {
      ...this.form.shell(),
      appId: this.form.field('appId'),
      appSecret: this.form.field('appSecret'),
      allowedUsers: this.form.field('allowedUsers'),
      workspaceDir: this.form.field('workspaceDir'),
      appSecretConfigured: (value?.appSecret ?? '') !== '',
      connectionStatus: value?.connectionStatus ?? '',
    }
  }

  /** Bump the test counter; the host bridge runs the connection test. */
  async testConnection(): Promise<void> {
    const current = this.scope.getSnapshot().value?.testCounter ?? 0
    await this.scope.set('testCounter', current + 1)
  }

  /** Build the face the card's slot registration injects. */
  inject(): QqBridgeCardFace {
    return {
      hooks: { qqBridgeCard: this.store },
      ...this.form.actions(),
      testConnection: () => this.testConnection(),
    }
  }
}
