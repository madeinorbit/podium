import { StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { color, mono } from '../theme/theme'
import { RootHeaderActions } from './RootHeaderActions'
import { useRootHeader } from './root-header-context'
import { rootHeaderProgress } from './root-header-progress'

/** First scroll-content row; never a second toolbar above a large title. */
export function RootTabTitle() {
  const header = useRootHeader()
  const offset = header?.offset
  const fade = useAnimatedStyle(() => ({
    opacity: offset ? 1 - rootHeaderProgress(offset.value) : 1,
  }))
  if (!header) return null
  return (
    <Animated.View
      style={[styles.block, fade]}
      pointerEvents={header.compact ? 'none' : 'auto'}
      aria-hidden={header.compact}
      accessibilityElementsHidden={header.compact}
      importantForAccessibility={header.compact ? 'no-hide-descendants' : 'auto'}
    >
      <View style={styles.row}>
        <Text accessibilityRole="header" dynamicTypeRamp="largeTitle" style={styles.title}>
          {header.title}
        </Text>
        {header.right ?? <RootHeaderActions actions={header.actions} />}
      </View>
      {header.leading}
      {header.subtitle != null ? (
        <Text
          dynamicTypeRamp="subheadline"
          style={[styles.subtitle, header.monoSubtitle && mono(500)]}
        >
          {header.subtitle}
        </Text>
      ) : null}
    </Animated.View>
  )
}

/** Leading content of the native inline bar, paired with the same subtitle. */
export function RootTabInlineTitle() {
  const header = useRootHeader()
  if (!header) return null
  return (
    <View style={styles.inline}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        dynamicTypeRamp="headline"
        style={styles.inlineTitle}
      >
        {header.title}
      </Text>
      {header.subtitle != null ? (
        <Text numberOfLines={1} dynamicTypeRamp="caption1" style={styles.inlineSubtitle}>
          {header.subtitle}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  block: { paddingTop: 4, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  title: { flex: 1, color: color.text, fontSize: 34, fontWeight: '700' },
  subtitle: { color: color.textDim, fontSize: 15, marginTop: 4 },
  inline: { justifyContent: 'center', minHeight: 44 },
  inlineTitle: { color: color.text, fontSize: 17, fontWeight: '600' },
  inlineSubtitle: { color: color.textDim, fontSize: 12 },
})
