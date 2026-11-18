import { createModifier } from '@expo/ui/swift-ui/modifiers'
import { requireNativeModule } from 'expo'
import { workingWordPhase } from './WorkingWord.shared'

requireNativeModule('PodiumListRow')

/** The @expo/ui text styles the native glint copy can draw in. */
export type GlintTextStyle =
  | 'largeTitle'
  | 'title'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'subheadline'
  | 'body'
  | 'callout'
  | 'footnote'
  | 'caption'
  | 'caption2'

/** Native Text keeps its own sizing, accessibility and Reduce Motion policy. The
 * glint draws a bright copy of `text` in `textStyle` (the row Text's own string
 * and `font({ textStyle })`) behind a Core Animation mask. */
export const workingWordGlint = (
  seed: string,
  active: boolean,
  text: string,
  textStyle: GlintTextStyle = 'footnote',
) =>
  createModifier('podiumWorkingWordGlint', {
    phase: workingWordPhase(seed),
    active,
    text,
    textStyle,
  })
