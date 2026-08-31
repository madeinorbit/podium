import type { NativeStackNavigationOptions } from 'expo-router'
import { color } from '../theme/theme'

export const tabStackOptions: NativeStackNavigationOptions = {
  headerShown: true,
  headerLargeTitleEnabled: true,
  headerLargeTitleShadowVisible: false,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  contentStyle: { backgroundColor: color.bg },
}
