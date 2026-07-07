import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { color, font, space } from '../theme/theme'

/**
 * Screen scaffold: safe-area aware background + optional compact header.
 * Tab screens pass no `onBack`; pushed screens get a chevron-back affordance.
 */
export function Screen({
  title,
  subtitle,
  onBack,
  backLabel,
  right,
  children,
  noHeader,
}: {
  title?: string
  subtitle?: string
  onBack?: () => void
  backLabel?: string
  right?: ReactNode
  children: ReactNode
  noHeader?: boolean
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {noHeader ? null : (
        <View style={styles.header}>
          {onBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={backLabel ?? 'Back'}
              onPress={onBack}
              style={styles.back}
              hitSlop={8}
            >
              <Text style={styles.backText}>‹ {backLabel ?? 'Back'}</Text>
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
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  back: {
    paddingVertical: space.xs,
  },
  backText: {
    color: color.accent,
    fontSize: font.body,
    fontWeight: '600',
  },
  titles: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: color.text,
    fontSize: font.heading,
    fontWeight: '700',
  },
  subtitle: {
    color: color.textFaint,
    fontSize: font.tiny,
    marginTop: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  body: {
    flex: 1,
  },
})
