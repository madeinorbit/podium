import { HeaderHeightContext } from 'expo-router/react-navigation'
import { Stack } from 'expo-router/stack'
import type { SFSymbol } from 'expo-symbols'
import { memo, type ReactNode, use, useMemo, useState } from 'react'
import { type LayoutChangeEvent, Platform, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { UPDATING_SUBTITLE, useWorkspaceRefreshSubtitle } from '../client/workspace-refresh'
import { HeaderInsetContext } from '../navigation/header-inset'
import {
  headerSubtitleOptions,
  nativeSubtitleAvailable,
  transparentDetailHeader,
} from '../navigation/native-stack'
import { color, font, mono, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { type AppIcon, ChevronLeft, ChevronRight } from './icons'
import { MenuSheet } from './MenuSheet'
import { PressableScale } from './PressableScale'
import { isMenuSection, type ScreenAction, type ScreenMenuEntry } from './screen-actions'

export type {
  ScreenAction,
  ScreenMenuEntry,
  ScreenMenuItem,
  ScreenMenuSection,
} from './screen-actions'

const noop = () => {}

const sfName = (icon: AppIcon): SFSymbol =>
  (typeof icon === 'object' && icon && 'ios' in icon ? icon.ios : icon) as SFSymbol

export function Screen({
  title,
  grouped,
  subtitle: normalSubtitle,
  onBack,
  backLabel,
  backTitle,
  backButtonDisplayMode = 'minimal',
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
  refreshing,
}: {
  title?: string
  /** Use the system grouped-list ground beneath content and navigation. */
  grouped?: boolean
  /** A string rides the native navigation subtitle; other nodes use the context strip. */
  subtitle?: ReactNode
  onBack?: () => void
  backLabel?: string
  /**
   * A logical Back destination inside this screen, such as deck -> chat.
   * Uses a native bar action instead of starting and cancelling a stack pop.
   * Unset, iOS owns the ordinary previous-screen Back button and its menu.
   */
  backTitle?: string
  /** Let UIKit show the previous screen's name when the bar has room. */
  backButtonDisplayMode?: 'default' | 'generic' | 'minimal'
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
  refreshing?: boolean
}) {
  // A screen reloading data it already shows (POD-7157 `refreshing`) speaks
  // through the same large-title subtitle as a workspace refresh, not a mark.
  const refreshSubtitle =
    useWorkspaceRefreshSubtitle() ?? (refreshing ? UPDATING_SUBTITLE : undefined)
  const subtitle = large ? (refreshSubtitle ?? normalSubtitle) : normalSubtitle
  const insets = useSafeAreaInsets()
  // Root tabs already float a transparent bar (the large title path); pushed
  // screens get the same on iOS so no opaque band sits over the content.
  const transparentBar = !noHeader && transparentDetailHeader
  // SF Symbols do not reach Android's toolbar, so it draws the actions itself.
  const androidActions = Platform.OS === 'android' && actions?.length ? actions : undefined
  const logicalBack = Platform.OS === 'ios' && backAs === 'chevron' && !!backTitle && !!onBack
  const nativeDismiss = Platform.OS === 'ios' && backAs === 'text' && !!onBack
  const nativeLeadingActions = useMemo(
    () =>
      nativeDismiss && onBack
        ? [
            {
              label: backLabel ?? 'Cancel',
              title: backLabel ?? 'Cancel',
              icon: ChevronLeft,
              onPress: onBack,
            },
            ...(leadingActions ?? []),
          ]
        : logicalBack && onBack
          ? [
              { label: `Back to ${backTitle}`, icon: ChevronLeft, onPress: onBack },
              ...(leadingActions ?? []),
            ]
          : leadingActions,
    [backLabel, backTitle, leadingActions, logicalBack, nativeDismiss, onBack],
  )
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
          headerBackButtonDisplayMode: backButtonDisplayMode,
          // Always set: stack options merge, so an omitted key would keep a
          // title set while the screen showed another page.
          headerBackTitle: backTitle,
          // Explicitly clear the override when paging back to the chat.
          headerBackVisible: logicalBack || nativeDismiss ? false : undefined,
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
          ...(right
            ? { headerRight: () => <View style={styles.actions}>{right}</View> }
            : androidActions
              ? { headerRight: () => <AndroidHeaderActions actions={androidActions} /> }
              : {}),
          ...(onBack && backAs === 'text' && !nativeDismiss
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
      {nativeLeadingActions?.length && (nativeDismiss || !(onBack && backAs === 'text')) ? (
        <ToolbarItems placement="left" actions={nativeLeadingActions} />
      ) : null}
      {actions?.length && !right && !androidActions ? (
        <ToolbarItems placement="right" actions={actions} />
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

/**
 * Native bar items: a button, or with `items` a pull-down menu. A `title`
 * draws as text with the icon trailing (a scope or range picker); otherwise
 * the item is the icon alone.
 *
 * Memoized on `actions`: Stack.Toolbar re-sends the bar's items whenever its
 * children change identity, so a caller that memoizes its actions keeps an
 * unrelated screen render off the native bar.
 */
const ToolbarItems = memo(function ToolbarItems({
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
            {menuEntries(action.items)}
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
})

/**
 * The menu's rows as Stack.Toolbar elements. Plain function calls, not
 * components: expo-router reads the element tree's props directly when it
 * builds the UIMenu, so every level must be a Menu or MenuAction element.
 * A section is an inline submenu (UIMenu's displayInline: a divided group);
 * a `submenu` section is a titled row that opens its entries.
 */
function menuEntries(entries: readonly ScreenMenuEntry[], path = ''): ReactNode[] {
  return entries.map((entry, index) => {
    const key = `${path}${index}:${isMenuSection(entry) ? (entry.title ?? 'section') : entry.label}`
    if (isMenuSection(entry)) {
      return (
        <Stack.Toolbar.Menu
          key={key}
          inline={!entry.submenu}
          title={entry.title ?? ''}
          icon={entry.icon ? sfName(entry.icon) : undefined}
        >
          {menuEntries(entry.items, `${key}/`)}
        </Stack.Toolbar.Menu>
      )
    }
    return (
      <Stack.Toolbar.MenuAction
        key={key}
        icon={entry.icon ? sfName(entry.icon) : undefined}
        isOn={entry.selected}
        destructive={entry.destructive}
        disabled={entry.disabled}
        subtitle={entry.hint}
        onPress={entry.onPress}
      >
        {entry.label}
      </Stack.Toolbar.MenuAction>
    )
  })
}

/** Android: header buttons, and a menu action's entries as the action sheet. */
function AndroidHeaderActions({ actions }: { actions: readonly ScreenAction[] }) {
  return (
    <View style={styles.actions}>
      {actions.map((action) =>
        action.items ? (
          <AndroidMenuButton key={action.label} action={action} />
        ) : (
          <HeaderButton key={action.label} label={action.label} onPress={action.onPress ?? noop}>
            <Icon as={action.icon} size={17} color={color.textDim} />
          </HeaderButton>
        ),
      )}
    </View>
  )
}

function AndroidMenuButton({ action }: { action: ScreenAction }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HeaderButton label={action.label} onPress={() => setOpen(true)}>
        <Icon as={action.icon} size={17} color={color.textDim} />
      </HeaderButton>
      <MenuSheet
        visible={open}
        {...(action.menuTitle ? { title: action.menuTitle } : {})}
        {...(action.testID ? { testID: action.testID } : {})}
        entries={action.items ?? []}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

// The system inline title barely grows with Dynamic Type; at accessibility
// sizes an unbounded title left the 44pt bar and covered the content below.
const TITLE_MAX_SCALE = 1.2

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
        <Text style={styles.titleText} numberOfLines={1} maxFontSizeMultiplier={TITLE_MAX_SCALE}>
          {title}
        </Text>
        <Icon as={ChevronRight} size={11} color={color.textFaint} />
      </View>
      {subtitle ? (
        <Text
          style={styles.titleSubtitle}
          numberOfLines={1}
          maxFontSizeMultiplier={TITLE_MAX_SCALE}
        >
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
