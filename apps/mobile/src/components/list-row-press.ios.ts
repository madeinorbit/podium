import { createModifier, createModifierWithEventListener } from '@expo/ui/swift-ui/modifiers'
import { requireNativeModule } from 'expo'

// Requiring the module registers its modifier before any native row renders.
requireNativeModule('PodiumListRow')

/** Apply to a row's label stack (not a Button). The native modifier wraps it in
 * the List's own Button: system highlight and label colours, taps open once,
 * drags never do. Rows using it must not set a custom listRowBackground. */
export const listRowPress = (onOpen: () => void) =>
  createModifierWithEventListener('podiumListRowPress', onOpen)

/** Unlike cell appearance, this excludes SwiftUI's prefetched offscreen rows. */
export const contentVisibility = (onChange: (visible: boolean) => void) =>
  createModifierWithEventListener('podiumContentVisibility', ({ visible }: { visible: boolean }) =>
    onChange(visible),
  )

/** Apply to a List under a ListSearchBar: on mount, the stacked search field
 * starts tucked under the large title (a deliberate pull reveals it). */
export const listSearchStartsHidden = ({
  canTuck,
  onReady,
}: {
  canTuck: boolean | null
  onReady: () => void
}) => createModifierWithEventListener('podiumSearchStartsHidden', onReady, { canTuck })

/** One physical pixel, from the title column to the card edge, at any display scale. */
export const listRowHairline = ({
  leading,
  trailing = 12,
  top = 0,
  first = false,
}: {
  leading: number
  trailing?: number
  top?: number
  first?: boolean
}) => createModifier('podiumRowHairline', { leading, trailing, top, visible: !first })
