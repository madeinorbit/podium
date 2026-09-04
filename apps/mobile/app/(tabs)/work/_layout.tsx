import { Stack } from 'expo-router/stack'
import { tabStackOptions } from '../../../src/navigation/native-stack'

export default function WorkLayout() {
  return <Stack screenOptions={tabStackOptions} />
}
