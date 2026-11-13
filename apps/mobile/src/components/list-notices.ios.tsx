import { RNHostView, VStack } from '@expo/ui/swift-ui'
import {
  frame,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  onGeometryChange,
} from '@expo/ui/swift-ui/modifiers'
import { type ReactElement, type ReactNode, useCallback, useState } from 'react'
import { View } from 'react-native'
import { NoticeLayoutContext } from './notice-layout'

function noticeRow(notice: ReactElement) {
  return <NativeNoticeRow>{notice}</NativeNoticeRow>
}

function NativeNoticeRow({ children }: { children: ReactElement }) {
  const [width, setWidth] = useState(0)
  const measureWidth = useCallback(({ width }: { width: number }) => {
    if (width > 0) setWidth(width)
  }, [])

  return (
    <VStack
      modifiers={[
        frame({ maxWidth: Infinity, alignment: 'leading' }),
        onGeometryChange(measureWidth),
        listRowBackground('transparent'),
        listRowSeparator('hidden'),
        listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
      ]}
    >
      <RNHostView matchContents={{ vertical: true }}>
        {/* SwiftUI supplies the section's width. Keep that exact Yoga root
            instead of measuring an unconstrained horizontal intrinsic size. */}
        <View collapsable={false} style={{ width }}>
          {width > 0 ? children : null}
        </View>
      </RNHostView>
    </VStack>
  )
}

/** Notices scroll below the large title and share the List's safe-area inset.
 * Null notices produce no SwiftUI row; visible rows take their content height. */
export function ListNotices({ children }: { children: ReactNode }) {
  return <NoticeLayoutContext value={noticeRow}>{children}</NoticeLayoutContext>
}
