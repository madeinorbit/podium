import { useImperativeHandle, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { VisibleContent } from '../lib/visible-content'
import type { ChatDeckPagerProps, PagerPage } from './chat-deck-pager.types'

/**
 * Without the native pager (Android, web tests) both pages stay mounted and the
 * hidden one is taken out of layout, so each keeps its scroll position.
 */
export function ChatDeckPager({ ref, chat, deck, onPageChange, onPageSettle }: ChatDeckPagerProps) {
  const [page, setPage] = useState<PagerPage>(0)
  useImperativeHandle(
    ref,
    () => ({
      setPage: (next) => {
        setPage(next)
        onPageChange?.(next)
        onPageSettle?.(next)
      },
    }),
    [onPageChange, onPageSettle],
  )
  return (
    <View style={styles.pager}>
      <View
        style={[styles.page, page !== 0 && styles.hidden]}
        aria-hidden={page !== 0}
        testID="pager-chat-page"
      >
        <VisibleContent visible={page === 0}>{chat}</VisibleContent>
      </View>
      <View
        style={[styles.page, page !== 1 && styles.hidden]}
        aria-hidden={page !== 1}
        testID="pager-deck-page"
      >
        <VisibleContent visible={page === 1}>{deck}</VisibleContent>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  pager: { flex: 1, minHeight: 0 },
  page: { flex: 1, minHeight: 0 },
  hidden: { display: 'none' },
})
