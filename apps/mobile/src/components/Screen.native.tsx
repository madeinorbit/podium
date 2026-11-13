import { HeaderHeightContext } from 'expo-router/react-navigation'
import { Stack } from 'expo-router/stack'
import type { SFSymbol } from 'expo-symbols'
import { type ReactNode, use, useState } from 'react'
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useWorkspaceRefreshSubtitle } from '../client/workspace-refresh'
import { HeaderInsetContext } from '../navigation/header-inset'
import {
  headerSubtitleOptions,
  nativeSubtitleAvailable,
  transparentDetailHeader,
} from '../navigation/native-stack'
import { color, font, mono, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { type AppIcon, ChevronRight } from './icons'
import { PressableScale } from './PressableScale'
import type { ScreenAction } from './screen-actions'

export type { ScreenAction, ScreenMenuItem } from './screen-actions'

const noop = () => {}

const sfName = (icon: AppIcon): SFSymbol =>
  (typeof icon === 'object' && icon && 'ios' in icon ? icon.ios : icon) as SFSymbol

export function Screen({
  title,
  grouped,
  subtitle: normalSubtitle,
  onBack,
  backLabel,
  backAs = 'chevron',
  leading,
  right,
  actions,
  leadingActions,
  children,
  large,
  noHeader,
  safeBottom,
  monoSubtitle,
  underHeader,
  onTitlePress,
}: {
  title?: string
  /** Use the system grouped-list ground beneath content and navigation. */
  grouped?: boolean
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
  /** Leading native bar items, such as a root tab's scope picker (Mail's mailbox pattern). */
  leadingActions?: readonly ScreenAction[]
  children: ReactNode
  /** Root tab screen: large title that collapses into the inline bar on scroll. */
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
  /**
   * Makes the pushed screen's title (and its subtitle) one button, the way
   * Messages opens the contact card from the name in its bar.
   */
  onTitlePress?: () => void
}) {
  const refreshSubtitle = useWorkspaceRefreshSubtitle()
  const subtitle = large ? (refreshSubtitle ?? normalSubtitle) : normalSubtitle
  const insets = useSafeAreaInsets()
  // Root tabs already float a transparent bar (the large title path); pushed
  // screens get the same on iOS so no opaque band sits over the content.
  const transparentBar = !noHeader && transparentDetailHeader
  const headerHeight = use(HeaderHeightContext) ?? 0
  const barInset = transparentBar ? headerHeight : 0

  const subtitleText = typeof subtitle === 'string' && subtitle ? subtitle : undefined
  const titleButton = onTitlePress !== undefined && !large && !noHeader
  const subtitleInBar =
    !titleButton &&
    nativeSubtitleAvailable &&
    subtitleText != null &&
    (!monoSubtitle || !!(large && refreshSubtitle))
  const stripSubtitle = subtitleInBar || (titleButton && subtitleText) ? null : subtitle
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
          ...(titleButton
            ? {
                headerTitle: () => (
                  <HeaderTitleButton
                    title={title ?? ''}
                    subtitle={subtitleText}
                    onPress={onTitlePress}
                  />
                ),
              }
            : {}),
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
      {leadingActions?.length && !(onBack && backAs === 'text') ? (
        <ToolbarItems placement="left" actions={leadingActions} />
      ) : null}
      {actions?.length && !right ? <ToolbarItems placement="right" actions={actions} /> : null}
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

/**
 * Native bar items: a button, or with `items` a pull-down menu. A `title`
 * draws as text with the icon trailing (a scope or range picker); otherwise
 * the item is the icon alone.
 */
function ToolbarItems({
  placement,
  actions,
}: {
  placement: 'left' | 'right'
  actions: readonly ScreenAction[]
}) {
  return (
    <Stack.Toolbar placement={placement}>
      {actions.map((action) =>
        action.items ? (
          <Stack.Toolbar.Menu
            key={action.label}
            icon={action.title ? undefined : sfName(action.icon)}
            accessibilityLabel={action.label}
          >
            {action.title ? <Stack.Toolbar.Label>{action.title}</Stack.Toolbar.Label> : null}
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
            icon={action.title ? undefined : sfName(action.icon)}
            accessibilityLabel={action.label}
            onPress={action.onPress ?? noop}
          >
            {action.title}
          </Stack.Toolbar.Button>
        ),
      )}
    </Stack.Toolbar>
  )
}

/** The bar's title as one target: name, a small forward chevron, and the
 *  subtitle beneath, in the system title and footnote styles. */
function HeaderTitleButton({
  title,
  subtitle,
  onPress,
}: {
  title: string
  subtitle?: string | undefined
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint="Opens task details"
      haptic={false}
      onPress={onPress}
      style={styles.titleButton}
    >
      <View style={styles.titleRow}>
        <Text style={styles.titleText} numberOfLines={1}>
          {title}
        </Text>
        <Icon as={ChevronRight} size={11} color={color.textFaint} />
      </View>
      {subtitle ? (
        <Text style={styles.titleSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </PressableScale>
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
  titleButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, maxWidth: 240 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  titleText: { ...sans(600), flexShrink: 1, color: color.text, fontSize: font.body },
  titleSubtitle: { ...sans(400), color: color.textDim, fontSize: font.tiny },
  textBack: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  textBackLabel: { ...sans(400), color: color.accentTint, fontSize: font.body },
})
