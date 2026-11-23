/** Only the native sheet's geometry is stubbed; panel rows and view model are real. */
import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { color } from '../src/theme/theme'
export function BottomSheet({
  visible,
  head,
  children,
  footer,
  contentStyle,
  virtualizedContent,
}: {
  visible: boolean
  head?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  contentStyle?: object
  virtualizedContent?: (scrollEnabled: boolean) => ReactNode
}) {
  if (!visible) return null
  return (
    <View style={styles.sheet}>
      <View style={styles.handle} />
      {head}
      {virtualizedContent ? (
        <View style={styles.body}>{virtualizedContent(true)}</View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={contentStyle}>
          {children}
        </ScrollView>
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  )
}
const styles = StyleSheet.create({
  sheet: {
    height: '100%',
    width: '100%',
    backgroundColor: color.bgSunken,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingTop: 8,
    overflow: 'hidden',
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.borderStrong,
    alignSelf: 'center',
    marginBottom: 12,
  },
  body: { flex: 1, minHeight: 0 },
  footer: {
    paddingBottom: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
})
