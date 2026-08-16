/**
 * The QQ bridge settings card: AppID/AppSecret credentials, the user
 * allowlist, the new-session working directory, a connection-test button, and
 * the host-reported connection status. The card uses the shared plugin-card
 * chrome (collapsible header, staged edits, save/discard footer) and the
 * shared field controls, so it matches the other plugin configuration cards
 * (Shell, Web search, …). The AppSecret field is write-only — the stored value
 * never renders; a blank draft leaves it untouched.
 *
 * @module @deepseek-ai/dsh-client-ui-qq-bridge/client/card
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PluginCard } from './PluginCard.tsx'
import { SecretField, ValueField } from './fields.tsx'
import { zh } from './locales.ts'
import type { QqBridgeCardFace } from './controller.ts'

/** Props the renderer binds for the QQ bridge card. */
export type QqBridgeCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<QqBridgeCardFace>

/** Simplified-Chinese copy for this card's chrome (the section owns the rest). */
const t = (key: keyof typeof zh): string => zh[key]

/**
 * Render the QQ bridge card.
 * @param props - the card snapshot and its form actions.
 * @returns the card.
 */
export function QqBridgeCard(props: QqBridgeCardProps) {
  const state = props.useQqBridgeCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="qqBridgeTitle"
      descriptionKey="qqBridgeDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="qq-bridge-appid"
        label={t('qqAppId')}
        hint={t('qqAppIdHint')}
        text={state.appId.text}
        // Generic plugin: no "restore default" concept — fields are plain
        // editable inputs.
        overridden={false}
        invalid={state.appId.invalid}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        onEdit={(text) => { props.edit('appId', text) }}
        onReset={() => {}}
      />
      <SecretField
        id="qq-bridge-secret"
        label={t('qqAppSecret')}
        hint={t('qqAppSecretHint')}
        text={state.appSecret.text}
        configured={state.appSecretConfigured}
        stateLabel={state.appSecretConfigured ? t('qqAppSecretSet') : t('qqAppSecretUnset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('appSecret', text) }}
      />
      <ValueField
        id="qq-bridge-users"
        label={t('qqAllowedUsers')}
        hint={t('qqAllowedUsersHint')}
        text={state.allowedUsers.text}
        overridden={false}
        invalid={state.allowedUsers.invalid}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        onEdit={(text) => { props.edit('allowedUsers', text) }}
        onReset={() => {}}
      />
      <ValueField
        id="qq-bridge-workdir"
        label={t('qqWorkspaceDir')}
        hint={t('qqWorkspaceDirHint')}
        text={state.workspaceDir.text}
        overridden={false}
        invalid={state.workspaceDir.invalid}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        onEdit={(text) => { props.edit('workspaceDir', text) }}
        onReset={() => {}}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => { void props.testConnection() }}
          style={{
            padding: '5px 12px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--dsh-border, #ccc)',
            background: 'var(--dsh-button-bg, #f5f5f5)',
            color: 'var(--dsh-text, #111)',
            cursor: 'pointer',
          }}
        >
          {t('qqTest')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--dsh-muted, #666)' }}>
          {state.connectionStatus !== '' ? state.connectionStatus : t('qqStatusUntested')}
        </span>
      </div>
    </PluginCard>
  )
}
