import { createContext, use } from 'react'

/**
 * The top inset a screen's content owes the transparent navigation bar above
 * it. `Screen` provides it: 0 when it pads the body itself (the default) and
 * on web or Android, the bar's height when the screen opts into running its
 * content under the bar (`underHeader`).
 */
export const HeaderInsetContext = createContext(0)

/**
 * For content that scrolls under the bar but cannot use
 * `contentInsetAdjustmentBehavior="automatic"`: an inverted transcript, or a
 * strip pinned to the top such as the deck bar. Plain scroll views should use
 * the automatic adjustment instead, which also tracks a collapsing bar.
 */
export function useHeaderInset(): number {
  return use(HeaderInsetContext)
}
