import { HeaderHeightContext } from 'expo-router/react-navigation'
import { Stack } from 'expo-router/stack'
import type { SFSymbol } from 'expo-symbols'
import { type ReactNode, use, useState } from 'react'
import { type LayoutChangeEvent, Platform, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { HeaderInsetContext } from '../navigation/header-inset'
import {
  headerSubtitleOptions,
  nativeSubtitleAvailable,
  transparentDetailHeader,
} from '../navigation/native-stack'
import { RootTabScreen } from '../navigation/RootTabScreen'
import { color, font, mono, sans, space } from '../theme/theme'
import type { AppIcon } from './icons'
import { PressableScale } from './PressableScale'
import type { ScreenAction } from './screen-actions'

export type { ScreenAction, ScreenMenuItem } from './screen-actions'

const noop = () => {}

const sfName = (icon: AppIcon): SFSymbol =>
  (typeof icon === 'object' && icon && 'ios' in icon ? icon.ios : icon) as SFSymbol

export function Screen(props: Parameters<typeof NativeScreen>[0]) {
  if (Platform.OS === 'ios' && props.large && !props.noHeader) return <RootTabScreen {...props} />
  return <NativeScreen {...props} />
}

function NativeScreen({
  title,
  grouped,
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
  underHeader,
}: {
  title?: string
  /** Use the system grouped-list ground beneath content and navigation. */
  grouped?: boolean
  /** Root titles carry the subtitle in both states; details use the native subtitle or context strip. */
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
  /** Root tab: first content-row title cross-fades into the native inline bar on scroll. */
  large?: boolean
  noHeader?: boolean
  safeBottom?: boolean
  bareBack?: boolean
  monoSubtitle?: boolean
  /**
   * Pushed screens on iOS: the content runs under the transparent bar and
   * insets itself, with `contentInsetAdjustmentBehavior="automatic"` on its
   * scroll view or {@link useHeaderInset} for an inverted list or a pinned
   * strip. Without it the body starts below the bar, which still draws
   * transparent but has nothing scrolling under it.
   */
  underHeader?: boolean
}) {
  const insets = useSafeAreaInsets()
  // Root tabs already float a transparent bar (the large title path); pushed
  // screens get the same on iOS so no opaque band sits over the content.
  const transparentBar = !noHeader && transparentDetailHeader
  const headerHeight = use(HeaderHeightContext) ?? 0
  const barInset = transparentBar ? headerHeight : 0

  const subtitleText = typeof subtitle === 'string' && subtitle ? subtitle : undefined
  const subtitleInBar = nativeSubtitleAvailable && subtitleText != null && !monoSubtitle
  const stripSubtitle = subtitleInBar ? null : subtitle
  const hasContext = !noHeader && (leading != null || stripSubtitle != null)
  const [contextHeight, setContextHeight] = useState(hasContext ? 44 : 0)
  // The context strip pins under the bar, so content under it starts below both.
  const runsUnder = (!!underHeader || !!large) && !hasContext
  const bodyInset = runsUnder ? 0 : barInset
  return (
    <View
      collapsable={false}
      style={[
        styles.root,
        grouped && styles.grouped,
        noHeader && { paddingTop: insets.top },
        safeBottom && { paddingBottom: insets.bottom },
      ]}
    >
      <Stack.Screen
        options={{
          title: title ?? '',
          contentStyle: { backgroundColor: grouped ? color.groupedBg : color.bg },
          headerShown: !noHeader,
          headerLargeTitleEnabled: !!large,
          headerLargeTitleShadowVisible: false,
          headerShadowVisible: false,
          headerTransparent: transparentBar,
          headerBackButtonDisplayMode: 'minimal',
          headerTitleStyle: { color: color.text },
          headerLargeTitleStyle: { color: color.text },
          ...headerSubtitleOptions(subtitleInBar ? subtitleText : undefined, { large }),
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
      <View
        style={[
          styles.body,
          (bodyInset > 0 || hasContext) && {
            paddingTop: bodyInset + (hasContext ? contextHeight : 0),
          },
        ]}
      >
        <HeaderInsetContext value={runsUnder ? barInset : 0}>{children}</HeaderInsetContext>
      </View>
      {hasContext ? (
        <View
          style={[styles.context, barInset > 0 && { top: barInset }]}
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
  grouped: { backgroundColor: color.groupedBg },
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
