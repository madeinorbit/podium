import { Stack } from 'expo-router/stack'
import { tabStackOptions } from '../../../src/navigation/native-stack'

export default function PulseLayout() {
  return <Stack screenOptions={tabStackOptions} />
}
