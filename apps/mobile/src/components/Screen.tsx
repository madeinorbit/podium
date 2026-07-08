import { LinearGradient } from 'expo-linear-gradient'
import { ChevronLeft } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, radius, space } from '../theme/theme'
import { Icon } from './Icon'

/**
 * Screen scaffold on the app's gradient canvas.
 *
 * Two header modes:
 *  - `large` (tab roots): an iOS-style large title block with the actions row
 *    floating on the same line — friendly, roomy.
 *  - compact (pushed screens): back chevron + centered-weight title.
 */
export function Screen({
  title,
  subtitle,
  onBack,
  backLabel,
  right,
  children,
  large,
  noHeader,
}: {
  title?: string
  subtitle?: string
  onBack?: () => void
  backLabel?: string
  right?: ReactNode
  children: ReactNode
  large?: boolean
  noHeader?: boolean
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[color.bgGradientTop, color.bg]}
        style={StyleSheet.absoluteFill}
        end={{ x: 0.3, y: 0.45 }}
      />
      <View style={[styles.inner, { paddingTop: insets.top }]}>
        {noHeader ? null : large ? (
          <View style={styles.largeHeader}>
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
          <View style={styles.header}>
            {onBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={backLabel ?? 'Back'}
                onPress={onBack}
                style={styles.back}
                hitSlop={10}
              >
                <Icon as={ChevronLeft} size={22} color={color.accent} />
              </Pressable>
            ) : null}
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

/** Round soft icon button for header action rows. */
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
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.md,
    gap: space.md,
  },
  largeTitles: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  largeTitle: {
    color: color.text,
    fontSize: font.largeTitle,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  largeSubtitle: {
    color: color.textFaint,
    fontSize: font.small,
    fontWeight: '500',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: space.sm,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titles: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: color.text,
    fontSize: font.heading,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  subtitle: {
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
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
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
