/**
 * Harness-only (POD-6297): a bottom sheet drawn in place, open. The app's
 * BottomSheet needs reanimated, gesture-handler and worklets, which a vite page
 * has no runtime for; the shared-tasks harness photographs the sheet's
 * CONTENT, so a framed column with the head above the body is the contract.
 */
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

export function BottomSheet(props: {
  visible: boolean
  head?: ReactNode
  footer?: ReactNode
  children?: ReactNode
}) {
  if (!props.visible) return null
  return (
    <View style={styles.sheet} testID="sheet">
      {props.head}
      {props.children}
      {props.footer}
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#1e2024',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
})
