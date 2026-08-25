/** Harness-only: the app's BlurView is a tinted surface the composer paints over. */
import type { ComponentProps } from 'react'
import { View } from 'react-native'

export function BlurView({
  intensity: _intensity,
  tint: _tint,
  ...rest
}: ComponentProps<typeof View> & { intensity?: number; tint?: string }) {
  return <View {...rest} />
}
