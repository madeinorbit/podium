import { requireNativeView } from 'expo'
import { type ReactNode, type Ref, useImperativeHandle, useRef } from 'react'
import { type NativeSyntheticEvent, StyleSheet, View, type ViewProps } from 'react-native'
import type { ChatDeckPagerProps, PagerPage } from './chat-deck-pager.types'

type PageEvent = NativeSyntheticEvent<{ page: number }>

interface NativePagerRef {
  setPage(page: number, animated: boolean): Promise<void>
}

const NativePager = requireNativeView<
  ViewProps & {
    ref?: Ref<NativePagerRef>
    children: ReactNode
    onPageChange?: (event: PageEvent) => void
    onPageSettle?: (event: PageEvent) => void
  }
>('PodiumPager')

const asPage = (event: PageEvent): PagerPage => (event.nativeEvent.page === 1 ? 1 : 0)

/**
 * The chat and its flight deck as two pages of one system paging scroll view
 * (modules/podium-pager). UIKit tracks the finger, locks the axis, snaps by
 * velocity and animates on the render server; the module declares how paging
 * yields to the back swipe, inner scrollers and row swipe actions.
 */
export function ChatDeckPager({ ref, chat, deck, onPageChange, onPageSettle }: ChatDeckPagerProps) {
  const native = useRef<NativePagerRef>(null)
  useImperativeHandle(
    ref,
    () => ({
      setPage: (page, animated = true) => {
        void native.current?.setPage(page, animated)
      },
    }),
    [],
  )
  return (
    <NativePager
      ref={native}
      style={styles.pager}
      onPageChange={onPageChange ? (event) => onPageChange(asPage(event)) : undefined}
      onPageSettle={onPageSettle ? (event) => onPageSettle(asPage(event)) : undefined}
    >
      <View collapsable={false} style={[styles.page, styles.first]}>
        {chat}
      </View>
      <View collapsable={false} style={[styles.page, styles.second]}>
        {deck}
      </View>
    </NativePager>
  )
}

const styles = StyleSheet.create({
  pager: { flex: 1, minHeight: 0 },
  // Yoga places page i at x = i × width; the native view mounts both inside
  // its scroll view, where those are content coordinates.
  page: { position: 'absolute', top: 0, bottom: 0, width: '100%' },
  first: { left: 0 },
  second: { left: '100%' },
})
