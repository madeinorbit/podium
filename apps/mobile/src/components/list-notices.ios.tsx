import { RNHostView, VStack } from '@expo/ui/swift-ui'
import { listRowBackground, listRowInsets, listRowSeparator } from '@expo/ui/swift-ui/modifiers'
import type { ReactElement, ReactNode } from 'react'
import { NoticeLayoutContext } from './notice-layout'

function noticeRow(notice: ReactElement) {
  return (
    <VStack
      modifiers={[
        listRowBackground('transparent'),
        listRowSeparator('hidden'),
        listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
      ]}
    >
      <RNHostView matchContents={{ vertical: true }}>{notice}</RNHostView>
    </VStack>
  )
}

/** Notices scroll below the large title and share the List's safe-area inset.
 * Null notices produce no SwiftUI row; visible rows take their content height. */
export function ListNotices({ children }: { children: ReactNode }) {
  return <NoticeLayoutContext value={noticeRow}>{children}</NoticeLayoutContext>
}
