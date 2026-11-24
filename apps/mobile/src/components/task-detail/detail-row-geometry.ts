import { alignmentGuide, listRowInsets } from '@expo/ui/swift-ui/modifiers'
import { useWindowDimensions } from 'react-native'
import { useLayoutMargin } from '../../hooks/useLayoutMargin'

/** Every detail row shares one content edge: 20pt, the native section header's
 * inset, so headers, the title, glyphs and action labels share one column. A row
 * that uses `listRowPress` must apply this after it: the press modifier wraps the
 * row in a Button, and row insets set inside that Button never reach the List. */
export const detailRowInsets = listRowInsets({ leading: 20, trailing: 16, top: 0, bottom: 0 })

/** Separators run from the row's text to the card's trailing edge, as in
 * Settings and the Work and Tasks lists. SwiftUI stops them at the content
 * edge, so the trailing guide is moved out by the row's trailing inset. Apply
 * after `listRowPress`, beside `detailRowInsets`. */
export function useDetailSeparator() {
  const { width } = useWindowDimensions()
  const margin = useLayoutMargin()
  return alignmentGuide('listRowSeparatorTrailing', width - 2 * margin - 20)
}
