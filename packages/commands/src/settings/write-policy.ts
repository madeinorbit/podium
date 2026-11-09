/** Minimal runtime policy needed to plan settings writes in a browser. */

import type { SettingsTier } from '@podium/model/browser'
import type { DeliveryClass } from '../contract'

export const SETTINGS_WRITE_COMMAND_BY_TIER = {
  // A personal leaf is a field of the person's `userPreferences` record (POD-6673).
  'personal-preference': 'records.userPreferences.edit',
  // An instance leaf is a field of the one `instancePreferences` record (POD-6677).
  'instance-preference': 'records.instancePreferences.edit',
  'server-secret': 'settings.setSecret',
} as const satisfies Record<SettingsTier, string>

export type SettingsWriteCommandName =
  | (typeof SETTINGS_WRITE_COMMAND_BY_TIER)[SettingsTier]
  | 'settings.clearSecret'

export const SETTINGS_WRITE_DELIVERY_CLASS = {
  'records.userPreferences.edit': 'offline-eligible',
  'records.instancePreferences.edit': 'offline-eligible',
  'settings.setSecret': 'online-sensitive',
  'settings.clearSecret': 'online-sensitive',
} as const satisfies Readonly<Record<SettingsWriteCommandName, DeliveryClass>>
