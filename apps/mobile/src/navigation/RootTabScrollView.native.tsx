import type { ComponentPropsWithRef } from 'react'
import { Platform, ScrollView } from 'react-native'
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { RootTabTitle } from './RootTabTitle'
import { useRootHeader } from './root-header-context'

export function RootTabScrollView({
  children,
  contentContainerStyle,
  ...props
}: ComponentPropsWithRef<typeof ScrollView>) {
  const header = useRootHeader()
  const insets = useSafeAreaInsets()
  const offset = header?.offset
  const onScroll = useAnimatedScrollHandler((event) => {
    if (offset) offset.value = Math.max(0, event.contentOffset.y + event.contentInset.top)
  })
  if (!header || Platform.OS !== 'ios')
    return (
      <ScrollView {...props} contentContainerStyle={contentContainerStyle}>
        {children}
      </ScrollView>
    )
  return (
    <Animated.ScrollView
      {...props}
      contentContainerStyle={contentContainerStyle}
      contentInsetAdjustmentBehavior="never"
      contentInset={{ top: insets.top }}
      contentOffset={{ x: 0, y: -insets.top }}
      scrollIndicatorInsets={{ top: insets.top + 44 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <RootTabTitle />
      {children}
    </Animated.ScrollView>
  )
}
