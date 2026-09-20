/**
 * POD-4446 — the hand-rolled arm entry: incremental view maintenance with
 * typed deltas (methodology §5.2). Implements shared/src/arm.ts; see
 * README.md for the idiom, the write path, and how to add a field.
 */

import { createElement, type ReactElement } from 'react'
import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import type { SliceLocals } from '../../shared/src/slice-types'
import { HandStore } from './store'

// DYNAMIC on purpose (not a bundle nicety): `./native` imports
// `react-native`, whose Flow-typed source the root node/unit lanes cannot
// parse. A static import would put that chain in every file importing this
// arm and break `bun run test:file` for the whole package (the POD-1220
// hazard, same as the legacy control's `./native`). The chunk loads only via
// `preloadHandNative()`; web entries never preload it.
type NativeModule = typeof import('./native')
let nativeModule: NativeModule | null = null

export function preloadHandNative(): Promise<void> {
  if (nativeModule !== null) return Promise.resolve()
  return import('./native').then((module) => {
    nativeModule = module
  })
}

function NativeHost({ store }: { store: HandStore }): ReactElement {
  if (nativeModule === null) {
    throw new Error('[hand] native list not preloaded — call preloadHandNative() first')
  }
  return createElement(nativeModule.HandNativeList, { store })
}

export const handArm: Arm = {
  create(source: RowSource, locals: SliceLocals): ArmHandle {
    const store = new HandStore(source, locals)
    return {
      snapshot: () => store.snapshot(),
      stats: store.stats,
      dispose: () => store.dispose(),
      mountWeb: (el: Element) => store.mountWeb(el),
      mountNative: (): ReactElement => createElement(NativeHost, { store }),
      // Test hook (rebuild oracle, native lane): the live store.
      store,
    } as ArmHandle & { store: HandStore }
  },
}
