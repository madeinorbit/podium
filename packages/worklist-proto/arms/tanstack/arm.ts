/**
 * POD-4448 — the TanStack DB arm entry: collections and live queries for
 * everything relational, one custom collection for the recursive part
 * (methodology §5.4). Implements shared/src/arm.ts; see README.md for the
 * idiom, the write path, and how to add a field.
 */

import { createElement, type ReactElement } from 'react'
import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import type { SliceLocals } from '../../shared/src/slice-types'
import { TanStackStore } from './store'

// DYNAMIC on purpose (not a bundle nicety): `./native` imports
// `react-native`, whose Flow-typed source the root node/unit lanes cannot
// parse. A static import would put that chain in every file importing this
// arm and break `bun run test:file` for the whole package (the POD-1220
// hazard, same as the other arms' `./native`). The chunk loads only via
// `preloadTanStackNative()`; web entries never preload it.
type NativeModule = typeof import('./native')
let nativeModule: NativeModule | null = null

export function preloadTanStackNative(): Promise<void> {
  if (nativeModule !== null) return Promise.resolve()
  return import('./native').then((module) => {
    nativeModule = module
  })
}

function NativeHost({ store }: { store: TanStackStore }): ReactElement {
  if (nativeModule === null) {
    throw new Error('[tanstack] native list not preloaded — call preloadTanStackNative() first')
  }
  return createElement(nativeModule.TanStackNativeList, { store })
}

export const tanstackArm: Arm = {
  create(source: RowSource, locals: SliceLocals): ArmHandle {
    const store = new TanStackStore(source, locals)
    return {
      snapshot: () => store.snapshot(),
      stats: store.stats,
      dispose: () => store.dispose(),
      mountWeb: (el: Element) => store.mountWeb(el),
      mountNative: (): ReactElement => createElement(NativeHost, { store }),
      // Test hook (native lane + unit tests read through it).
      store,
    } as ArmHandle & { store: TanStackStore }
  },
}
