import { Slot } from 'expo-router'
import { SettingsOpening } from '../../../src/screens/settings-opening'

export default function SettingsLayout() {
  return (
    <SettingsOpening>
      <Slot />
    </SettingsOpening>
  )
}
