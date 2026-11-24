import type { ReactNode } from 'react'
import type { StyleProp, TextProps, TextStyle } from 'react-native'

export interface WorkingWordProps {
  children: ReactNode
  seed: string
  active?: boolean
  style?: StyleProp<TextStyle>
  numberOfLines?: TextProps['numberOfLines']
  maxFontSizeMultiplier?: TextProps['maxFontSizeMultiplier']
  /** A matching copy with only the working portion visible, for mixed-colour lines. */
  glint?: ReactNode
}

/** The desktop deck's stable row phase. */
export function workingWordPhase(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return ((hash >>> 0) % 1000) / 1000
}
