import { Stack } from 'expo-router/stack'
import { type ReactNode, useState } from 'react'
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { flow } from '../theme/issueColors'
import { color, font, mono, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

export function Screen({
  title,
  subtitle,
  onBack,
  backLabel,
  backAs = 'chevron',
  leading,
  right,
  children,
  large,
  noHeader,
  safeBottom,
  accent,
  monoSubtitle,
}: {
  title?: string
  subtitle?: ReactNode
  onBack?: () => void
  backLabel?: string
  backAs?: 'chevron' | 'text'
  leading?: ReactNode
  right?: ReactNode
  children: ReactNode
  large?: boolean
  noHeader?: boolean
  safeBottom?: boolean
  accent?: string
  bareBack?: boolean
  monoSubtitle?: boolean
}) {
  const insets = useSafeAreaInsets()
  const hasContext = !noHeader && (leading != null || subtitle != null)
  const [contextHeight, setContextHeight] = useState(hasContext ? 44 : 0)
  const chrome = accent
    ? {
        headerStyle: { backgroundColor: flow.headerBg(accent) },
        bodyStyle: { backgroundColor: flow.paneBg(accent) },
      }
    : null
  return (
    <View
      style={[
        styles.root,
        chrome?.bodyStyle,
        noHeader && { paddingTop: insets.top },
        safeBottom && { paddingBottom: insets.bottom },
      ]}
    >
      <Stack.Screen
        options={{
          title: title ?? '',
          headerShown: !noHeader,
          headerLargeTitleEnabled: !!large,
          headerLargeTitleShadowVisible: false,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          ...(chrome ? { headerStyle: chrome.headerStyle } : {}),
          ...(right ? { headerRight: () => <View style={styles.actions}>{right}</View> } : {}),
          ...(onBack && backAs === 'text'
            ? {
                headerLeft: () => (
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={backLabel ?? 'Cancel'}
                    haptic={false}
                    onPress={onBack}
                    style={styles.textBack}
                  >
                    <Text style={styles.textBackLabel}>{backLabel ?? 'Cancel'}</Text>
                  </PressableScale>
                ),
              }
            : {}),
        }}
      />
      <View style={[styles.body, hasContext && { paddingTop: contextHeight }]}>{children}</View>
      {hasContext ? (
        <View
          style={styles.context}
          onLayout={(event: LayoutChangeEvent) => setContextHeight(event.nativeEvent.layout.height)}
        >
          {leading}
          {subtitle ? (
            <Text
              dynamicTypeRamp="caption1"
              numberOfLines={2}
              style={[styles.contextText, monoSubtitle && styles.monoContext]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

export function HeaderButton({
  label,
  onPress,
  children,
}: {
  label: string
  onPress: () => void
  children: ReactNode
  size?: 28 | 32 | 34
  bare?: boolean
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      haptic={false}
      onPress={onPress}
      style={styles.headerButton}
    >
      {children}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: color.bg },
  body: { flex: 1, minHeight: 0 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  context: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  contextText: {
    ...sans(400),
    flex: 1,
    color: color.textDim,
    fontSize: font.micro,
  },
  monoContext: { ...mono(500), color: color.label },
  headerButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBack: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  textBackLabel: { ...sans(400), color: color.accentTint, fontSize: font.body },
})
