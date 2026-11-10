import { Stack } from 'expo-router/stack'
import { tabStackOptions } from '../../../src/navigation/native-stack'
import { noticeScreenLayout } from '../../../src/navigation/notice-screen-layout'
import { SettingsOpening } from '../../../src/screens/settings-opening'

export default function SettingsLayout() {
  return (
    <SettingsOpening>
      <Stack screenOptions={tabStackOptions} screenLayout={noticeScreenLayout} />
    </SettingsOpening>
  )
}
