import { Stack } from 'expo-router/stack'
import type { SFSymbol } from 'expo-symbols'
import { type ReactNode, useState } from 'react'
import { type LayoutChangeEvent, Platform, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, mono, sans, space } from '../theme/theme'
import type { AppIcon } from './icons'
import { PressableScale } from './PressableScale'
import type { ScreenAction } from './screen-actions'

export type { ScreenAction, ScreenMenuItem } from './screen-actions'

/**
 * iOS 26 gives the navigation item a native subtitle: under the large title at
 * rest and under the inline title once it collapses. Earlier systems and
 * Android keep the context strip below the bar.
 */
const nativeSubtitle = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26

const noop = () => {}

const sfName = (icon: AppIcon): SFSymbol =>
  (typeof icon === 'object' && icon && 'ios' in icon ? icon.ios : icon) as SFSymbol

export function Screen({
  title,
  subtitle,
  onBack,
  backLabel,
  backAs = 'chevron',
  leading,
  right,
  actions,
  children,
  large,
  noHeader,
  safeBottom,
  monoSubtitle,
}: {
  title?: string
  /** A string rides the native navigation subtitle; other nodes use the context strip. */
  subtitle?: ReactNode
  onBack?: () => void
  backLabel?: string
  backAs?: 'chevron' | 'text'
  leading?: ReactNode
  /** Custom trailing header content. Prefer `actions`, which draws native bar items. */
  right?: ReactNode
  /** Trailing native bar items (buttons or pull-down menus), drawn in system glass. */
  actions?: readonly ScreenAction[]
  children: ReactNode
  /** Root tab screen: large title that collapses into the inline bar on scroll. */
  large?: boolean
  noHeader?: boolean
  safeBottom?: boolean
  bareBack?: boolean
  monoSubtitle?: boolean
}) {
  const insets = useSafeAreaInsets()
  const subtitleText = typeof subtitle === 'string' && subtitle ? subtitle : undefined
  const subtitleInBar = nativeSubtitle && subtitleText != null && !monoSubtitle
  const stripSubtitle = subtitleInBar ? null : subtitle
  const hasContext = !noHeader && (leading != null || stripSubtitle != null)
  const [contextHeight, setContextHeight] = useState(hasContext ? 44 : 0)
  return (
    <View
      collapsable={false}
      style={[
        styles.root,
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
          headerTitleStyle: { color: color.text },
          headerLargeTitleStyle: { color: color.text },
          // `subtitle`/`largeSubtitle` come from patches/react-native-screens@4.26.2.patch,
          // which the public header-config type does not list.
          unstable_nativeProps: {
            headerConfig: (subtitleInBar
              ? { subtitle: subtitleText, largeSubtitle: large ? subtitleText : undefined }
              : { subtitle: undefined, largeSubtitle: undefined }) as object,
          },
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
      {actions?.length && !right ? (
        <Stack.Toolbar placement="right">
          {actions.map((action) =>
            action.items ? (
              <Stack.Toolbar.Menu
                key={action.label}
                icon={sfName(action.icon)}
                accessibilityLabel={action.label}
              >
                {action.items.map((item) => (
                  <Stack.Toolbar.MenuAction
                    key={item.label}
                    icon={item.icon ? sfName(item.icon) : undefined}
                    isOn={item.selected}
                    destructive={item.destructive}
                    onPress={item.onPress}
                  >
                    {item.label}
                  </Stack.Toolbar.MenuAction>
                ))}
              </Stack.Toolbar.Menu>
            ) : (
              <Stack.Toolbar.Button
                key={action.label}
                icon={sfName(action.icon)}
                accessibilityLabel={action.label}
                onPress={action.onPress ?? noop}
              />
            ),
          )}
        </Stack.Toolbar>
      ) : null}
      <View style={[styles.body, hasContext && { paddingTop: contextHeight }]}>{children}</View>
      {hasContext ? (
        <View
          style={styles.context}
          onLayout={(event: LayoutChangeEvent) => setContextHeight(event.nativeEvent.layout.height)}
        >
          {leading}
          {stripSubtitle ? (
            <Text
              dynamicTypeRamp="caption1"
              numberOfLines={2}
              style={[styles.contextText, monoSubtitle && styles.monoContext]}
            >
              {stripSubtitle}
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
