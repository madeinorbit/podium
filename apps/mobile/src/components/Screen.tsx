import { ChevronLeft } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { flow } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'

/**
 * Screen scaffold on the flat near-black canvas (#0e0e12).
 *
 * Two header modes:
 *  - `large` (tab roots): title block with the actions row on the same line.
 *  - compact (pushed screens): back chevron + title, 44px-bar density.
 *
 * `accent` runs the issue colour flow through the chrome (colour-flow §2.8):
 * header 16% tint over the card surface with a .45-alpha bottom hairline, body
 * 10% over the canvas. Pass FLOW_SLATE for issues without a colour.
 */
export function Screen({
  title,
  subtitle,
  onBack,
  backLabel,
  leading,
  right,
  children,
  large,
  noHeader,
  accent,
}: {
  title?: string
  subtitle?: string
  onBack?: () => void
  backLabel?: string
  /** Slot between the back chevron and the titles (the 18px ID square). */
  leading?: ReactNode
  right?: ReactNode
  children: ReactNode
  large?: boolean
  noHeader?: boolean
  accent?: string
}) {
  const insets = useSafeAreaInsets()
  const tint = accent
    ? {
        header: { backgroundColor: flow.headerBg(accent), borderBottomColor: alpha(accent, 0.45) },
        body: { backgroundColor: flow.paneBg(accent) },
      }
    : null
  return (
    <View style={[styles.root, tint ? tint.body : null]}>
      <View style={[styles.inner, noHeader ? { paddingTop: insets.top } : null]}>
        {noHeader ? null : large ? (
          <View style={[styles.largeHeader, { paddingTop: insets.top + space.md }]}>
            <View style={styles.largeTitles}>
              <Text style={styles.largeTitle} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={styles.largeSubtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            {right ? <View style={styles.right}>{right}</View> : null}
          </View>
        ) : (
          <View style={[styles.header, tint ? tint.header : null, { paddingTop: insets.top + 6 }]}>
            {onBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={backLabel ?? 'Back'}
                onPress={onBack}
                style={styles.back}
                hitSlop={10}
              >
                <Icon as={ChevronLeft} size={17} color={color.textDim} />
              </Pressable>
            ) : null}
            {leading}
            <View style={styles.titles}>
              {title ? (
                <Text style={styles.title} numberOfLines={1}>
                  {title}
                </Text>
              ) : null}
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={1}>
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

/** Square chip icon button for header action rows (28px, #16161c on #2e2e38). */
export function HeaderButton({
  label,
  onPress,
  children,
}: {
  label: string
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
    >
      {children}
    </Pressable>
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
    fontSize: 20,
    letterSpacing: -0.3,
  },
  largeSubtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny + 1,
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
  titles: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    letterSpacing: -0.1,
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    marginTop: 1,
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
  body: {
    flex: 1,
  },
})
