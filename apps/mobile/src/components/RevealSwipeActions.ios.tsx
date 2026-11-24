import { SwipeActions } from '@expo/ui/swift-ui'
import type { ReactNode } from 'react'

/**
 * The only way a row in this app declares swipe actions. A swipe REVEALS the
 * buttons and the user taps one; a full swipe never performs the first action.
 *
 * SwiftUI's `swipeActions(allowsFullSwipe:)` defaults to true, so a fast flick
 * across a row (a page-back flick on the flight deck, a scroll that drifts
 * sideways) could commit Start, Close or Unsnooze with no tap at all [POD-2527].
 * Every edge goes through here so no call site can opt back in.
 */
export function RevealSwipeActions({
  edge,
  children,
}: {
  edge: 'leading' | 'trailing'
  children: ReactNode
}) {
  return (
    <SwipeActions.Actions edge={edge} allowsFullSwipe={false}>
      {children}
    </SwipeActions.Actions>
  )
}
