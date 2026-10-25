import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, mono, radius, sans, space, tracking } from '../theme/theme'
import { Icon } from './Icon'
import { ChevronLeft } from './icons'
import { PressableScale } from './PressableScale'

/**
 * Screen scaffold on the flat Dark Ink canvas (`color.bg`, #16171a).
 *
 * Two header modes:
 *  - `large` (tab roots): title block with the actions row on the same line.
 *  - compact (pushed screens): back chevron + title, 44px-bar density.
 */
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
  bareBack = false,
  monoSubtitle = false,
}: {
  title?: string
  subtitle?: ReactNode
  onBack?: () => void
  backLabel?: string
  /**
   * How the leading dismiss control reads [POD-366]. A pushed destination gets
   * the chevron; a sheet you can abandon (the create forms, settings) gets the
   * word, matching how iOS distinguishes the two.
   */
  backAs?: 'chevron' | 'text'
  /** Slot between the back chevron and the titles (the 18px ID square). */
  leading?: ReactNode
  right?: ReactNode
  children: ReactNode
  large?: boolean
  noHeader?: boolean
  /** Pay the bottom safe area when no tab bar or sheet owns that inset. */
  safeBottom?: boolean
  /** Pocket chat uses an unboxed navigation chevron. */
  bareBack?: boolean
  /** Ledger/chat metadata uses the compact monospace datum voice. */
  monoSubtitle?: boolean
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={styles.root}>
      <View
        style={[
          styles.inner,
          noHeader ? { paddingTop: insets.top } : null,
          safeBottom ? { paddingBottom: insets.bottom } : null,
        ]}
      >
        {noHeader ? null : large ? (
          <View style={[styles.largeHeader, { paddingTop: insets.top + space.md }]}>
            <View style={styles.largeTitles}>
              <Text style={styles.largeTitle} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text
                  style={[styles.largeSubtitle, monoSubtitle && styles.monoSubtitle]}
                  numberOfLines={1}
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>
            {right ? <View style={styles.right}>{right}</View> : null}
          </View>
        ) : (
          <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
            {onBack ? (
              backAs === 'text' ? (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={backLabel ?? 'Cancel'}
                  onPress={onBack}
                  hitSlop={10}
                >
                  <Text style={styles.backText}>{backLabel ?? 'Cancel'}</Text>
                </PressableScale>
              ) : (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={backLabel ?? 'Back'}
                  onPress={onBack}
                  style={[styles.back, bareBack && styles.backBare]}
                  hitSlop={10}
                >
                  <Icon as={ChevronLeft} size={17} color={color.textDim} />
                </PressableScale>
              )
            ) : null}
            {leading}
            <View style={styles.titles}>
              {title ? (
                <Text style={styles.title} numberOfLines={1}>
                  {title}
                </Text>
              ) : null}
              {subtitle ? (
                <Text
                  style={[styles.subtitle, monoSubtitle && styles.monoSubtitle]}
                  numberOfLines={1}
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>
            {right ? <View style={styles.right}>{right}</View> : null}
          </View>
        )}
        <View style={styles.body}>{children}</View>
      </View>
    </View>
  )
}

/** Square chip icon button for header action rows (28px `color.surface`). */
export function HeaderButton({
  label,
  onPress,
  children,
  size = 28,
  bare = false,
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
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.headerBtn,
        { width: size, height: size },
        bare && styles.headerBtnBare,
        pressed && styles.headerBtnPressed,
      ]}
    >
      {children}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  inner: {
    flex: 1,
  },
  largeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.md,
  },
  largeTitles: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  largeTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.largeTitle,
    letterSpacing: tracking[font.largeTitle],
  },
  largeSubtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    gap: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  back: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineBar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBare: {
    width: 34,
    height: 34,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  backText: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.small,
  },
  titles: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    letterSpacing: tracking[font.body],
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    marginTop: 1,
  },
  monoSubtitle: {
    ...mono(500),
    fontSize: 11,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  headerBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineBar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnPressed: {
    backgroundColor: color.surfacePressed,
  },
  headerBtnBare: {
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  body: {
    flex: 1,
  },
})
