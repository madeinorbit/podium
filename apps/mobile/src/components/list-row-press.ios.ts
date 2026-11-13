import { createModifierWithEventListener } from '@expo/ui/swift-ui/modifiers'
import { requireNativeModule } from 'expo'

// Requiring the module registers its modifier before any native row renders.
requireNativeModule('PodiumListRow')

/** Apply to a native Button with no onPress; native tap/assistive actions own activation. */
export const listRowPress = (onOpen: () => void) =>
  createModifierWithEventListener('podiumListRowPress', onOpen)
