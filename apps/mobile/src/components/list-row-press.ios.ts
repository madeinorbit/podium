import { createModifierWithEventListener } from '@expo/ui/swift-ui/modifiers'
import { requireNativeModule } from 'expo'

// Requiring the module registers its modifier before any native row renders.
requireNativeModule('PodiumListRow')

/** Apply to a row's label stack (not a Button). The native modifier wraps it in
 * the List's own Button: system highlight and label colours, taps open once,
 * drags never do. Rows using it must not set a custom listRowBackground. */
export const listRowPress = (onOpen: () => void) =>
  createModifierWithEventListener('podiumListRowPress', onOpen)

/** Apply to a List under a ListSearchBar: on mount, the stacked search field
 * starts tucked under the large title (a deliberate pull reveals it). */
export const listSearchStartsHidden = ({
  canTuck,
  onReady,
}: {
  canTuck: boolean | null
  onReady: () => void
}) => createModifierWithEventListener('podiumSearchStartsHidden', onReady, { canTuck })
