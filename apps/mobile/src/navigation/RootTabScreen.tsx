import { Stack } from 'expo-router/stack'
import { type ReactNode, useState } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleOnRN } from 'react-native-worklets'
import type { ScreenAction } from '../components/screen-actions'
import { color } from '../theme/theme'
import { HeaderInsetContext } from './header-inset'
import { LegacyRootScrollObserver } from './LegacyRootScrollObserver'
import { RootHeaderActions } from './RootHeaderActions'
import { RootTabInlineTitle } from './RootTabTitle'
import { RootHeaderContext } from './root-header-context'
import { rootHeaderProgress } from './root-header-progress'

/** UIKit retains the bar and scroll-edge material. Only its contents cross-fade. */
export function RootTabScreen({
  title,
  subtitle,
  actions,
  right,
  leading,
  monoSubtitle,
  grouped,
  safeBottom,
  children,
}: {
  title?: string
  subtitle?: ReactNode
  actions?: readonly ScreenAction[]
  right?: ReactNode
  leading?: ReactNode
  monoSubtitle?: boolean
  grouped?: boolean
  safeBottom?: boolean
  children: ReactNode
}) {
  const offset = useSharedValue(0)
  const [compact, setCompact] = useState(false)
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  // Accessibility/touch ownership changes once per crossing, never per frame.
  useAnimatedReaction(
    () => rootHeaderProgress(offset.value) >= 0.5,
    (next, previous) => {
      if (next !== previous) scheduleOnRN(setCompact, next)
    },
  )
  const fade = useAnimatedStyle(() => ({ opacity: rootHeaderProgress(offset.value) }))
  const accessibility = {
    pointerEvents: compact ? ('auto' as const) : ('none' as const),
    'aria-hidden': !compact,
    accessibilityElementsHidden: !compact,
    importantForAccessibility: compact ? ('auto' as const) : ('no-hide-descendants' as const),
  }
  const header = { title, subtitle, actions, right, leading, monoSubtitle, offset, compact }
  return (
    <RootHeaderContext value={header}>
      <View
        style={[
          styles.root,
          { backgroundColor: grouped ? color.groupedBg : color.bg },
          safeBottom && { paddingBottom: insets.bottom },
        ]}
      >
        <Stack.Screen
          options={{
            title: '',
            headerShown: true,
            headerLargeTitleEnabled: false,
            headerTransparent: true,
            headerShadowVisible: false,
            headerBackVisible: false,
            contentStyle: { backgroundColor: grouped ? color.groupedBg : color.bg },
          }}
        />
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.View hidesSharedBackground>
            <Animated.View
              {...accessibility}
              style={[styles.inline, { maxWidth: Math.max(120, width - 160) }, fade]}
            >
              <RootHeaderContext value={header}>
                <RootTabInlineTitle />
              </RootHeaderContext>
            </Animated.View>
          </Stack.Toolbar.View>
        </Stack.Toolbar>
        {right || actions?.length ? (
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.View hidesSharedBackground>
              <Animated.View {...accessibility} style={fade}>
                {right ?? <RootHeaderActions actions={actions} />}
              </Animated.View>
            </Stack.Toolbar.View>
          </Stack.Toolbar>
        ) : null}
        <HeaderInsetContext value={0}>{children}</HeaderInsetContext>
        <LegacyRootScrollObserver />
      </View>
    </RootHeaderContext>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  inline: { justifyContent: 'center', minHeight: 44 },
})
