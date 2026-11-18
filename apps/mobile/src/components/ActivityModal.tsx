import type { ComponentProps } from 'react'
import { Modal as NativeModal } from 'react-native'
import { SheetActivity } from '../lib/visible-content'

/** Every native modal covers the screen's activity without navigator blur. */
export function ActivityModal(props: ComponentProps<typeof NativeModal>) {
  return (
    <SheetActivity visible={props.visible !== false}>
      <NativeModal {...props} />
    </SheetActivity>
  )
}
