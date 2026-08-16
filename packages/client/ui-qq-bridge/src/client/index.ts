/**
 * QQ bridge settings card, browser half — registers the `settings.plugin.item`
 * card in the Plugins settings section.
 *
 * @module @deepseek-ai/dsh-client-ui-qq-bridge/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { QqBridgeCardController } from './controller.ts'
import { QqBridgeCard } from './QqBridgeCard.tsx'

/** Settings namespace the Host bridge registers. */
const QQ_BRIDGE_NS = 'qq-bridge'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'settingsScope']

/**
 * Mount the QQ bridge settings card into the Plugins settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new QqBridgeCardController(ctx.settingsScope.bind({ namespace: QQ_BRIDGE_NS }))

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'qq-bridge',
      order: 30,
      inject: () => controller.inject(),
    }, QqBridgeCard)
  })
}
