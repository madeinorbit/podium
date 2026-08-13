/** Minimal runtime policy needed to plan settings writes in a browser. */

import type { SettingsTier } from '@podium/model/browser'
import type { DeliveryClass } from '../contract'

export const SETTINGS_WRITE_COMMAND_BY_TIER = {
  'personal-preference': 'settings.updatePersonal',
  'instance-preference': 'settings.updateInstance',
  'server-secret': 'settings.setSecret',
} as const satisfies Record<SettingsTier, string>

export type SettingsWriteCommandName =
  | (typeof SETTINGS_WRITE_COMMAND_BY_TIER)[SettingsTier]
  | 'settings.clearSecret'

export const SETTINGS_WRITE_DELIVERY_CLASS = {
  'settings.updatePersonal': 'offline-eligible',
  'settings.updateInstance': 'offline-eligible',
  'settings.setSecret': 'online-sensitive',
  'settings.clearSecret': 'online-sensitive',
} as const satisfies Readonly<Record<SettingsWriteCommandName, DeliveryClass>>
