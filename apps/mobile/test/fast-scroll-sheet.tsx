/** Scroll-only fixture: native sheet gestures are outside this browser proof. */
import type { ReactNode } from 'react'

export function BottomSheet({ visible, head, virtualizedContent }: {
  visible: boolean
  head?: ReactNode
  virtualizedContent?: (scrollEnabled: boolean) => ReactNode
}) {
  return visible ? <div style={{ height: 650, display: 'flex', flexDirection: 'column' }}>
    {head}
    {virtualizedContent?.(true)}
  </div> : null
}
