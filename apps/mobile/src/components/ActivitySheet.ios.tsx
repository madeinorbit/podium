import { BottomSheet } from '@expo/ui/swift-ui'
import type { ComponentProps } from 'react'
import { SheetActivity } from '../lib/visible-content'

/** SwiftUI sheets have the same route coverage as RN modals. */
export function ActivitySheet(props: ComponentProps<typeof BottomSheet>) {
  return (
    <SheetActivity visible={props.isPresented ?? false}>
      <BottomSheet {...props} />
    </SheetActivity>
  )
}
