import { Stack } from 'expo-router/stack'
import { tabStackOptions } from '../../../src/navigation/native-stack'
import { noticeScreenLayout } from '../../../src/navigation/notice-screen-layout'

export default function PulseLayout() {
  return <Stack screenOptions={tabStackOptions} screenLayout={noticeScreenLayout} />
}
