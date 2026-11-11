import type { ReactNode } from 'react'
import { createContext, use } from 'react'
import type { SharedValue } from 'react-native-reanimated'
import type { ScreenAction } from '../components/screen-actions'

export interface RootHeaderState {
  title?: string
  subtitle?: ReactNode
  actions?: readonly ScreenAction[]
  right?: ReactNode
  leading?: ReactNode
  monoSubtitle?: boolean
  offset: SharedValue<number>
  compact: boolean
  /** iOS 16/17 keeps both header states visible without scroll-driven effects. */
  fadeEnabled?: boolean
}

export const RootHeaderContext = createContext<RootHeaderState | null>(null)
export const useRootHeader = () => use(RootHeaderContext)
