import { Stack } from 'expo-router/stack'
import { type ReactNode, useState } from 'react'
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native'
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
  const fadeEnabled = Number.parseInt(String(Platform.Version), 10) >= 18
  const offset = useSharedValue(0)
  const [compact, setCompact] = useState(false)
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const actionCount = actions?.length ?? 0
  const actionWidth = right ? 96 : actionCount * 44 + Math.max(0, actionCount - 1) * 8
  const titleWidth = Math.max(80, width - insets.left - insets.right - 40 - actionWidth - 12)
  // Accessibility/touch ownership changes once per crossing, never per frame.
  useAnimatedReaction(
    () => fadeEnabled && rootHeaderProgress(offset.value) >= 0.5,
    (next, previous) => {
      if (next !== previous) scheduleOnRN(setCompact, next)
    },
  )
  const fade = useAnimatedStyle(() => ({
    opacity: fadeEnabled ? rootHeaderProgress(offset.value) : 1,
  }))
  const barVisible = !fadeEnabled || compact
  const accessibility = {
    pointerEvents: barVisible ? ('auto' as const) : ('none' as const),
    'aria-hidden': !barVisible,
    accessibilityElementsHidden: !barVisible,
    importantForAccessibility: barVisible ? ('auto' as const) : ('no-hide-descendants' as const),
  }
  const header = {
    title,
    subtitle,
    actions,
    right,
    leading,
    monoSubtitle,
    offset,
    compact,
    fadeEnabled,
  }
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
              style={[styles.inline, { maxWidth: titleWidth }, fade]}
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
      </View>
    </RootHeaderContext>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  inline: { justifyContent: 'center', minHeight: 44 },
})
