import { createModifier } from '@expo/ui/swift-ui/modifiers'
import { requireNativeModule } from 'expo'
import { workingWordPhase } from './WorkingWord.shared'

requireNativeModule('PodiumListRow')

/** Native Text keeps its own mask, sizing, accessibility and Reduce Motion policy. */
export const workingWordGlint = (seed: string, active = true) =>
  createModifier('podiumWorkingWordGlint', { phase: workingWordPhase(seed), active })
