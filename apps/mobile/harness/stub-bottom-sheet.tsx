/**
 * Harness-only: the app's BottomSheet drags in reanimated, gesture-handler and
 * worklets, none of which this vite page has a runtime for. Every captured
 * state has the sheet closed, so a sheet that draws nothing is the whole
 * contract the harness needs.
 */
import type { ReactNode } from 'react'

export function BottomSheet(_props: { visible: boolean; children?: ReactNode }) {
  return null
}
